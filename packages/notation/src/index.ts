// 베이스 TAB → 기보 모델(출력 전용). 원본 Project 는 읽기만 하며 재생 타이밍·데이터를 바꾸지 않는다.
// 클립 배치·트림(sourceOffset/duration)·루프는 재생 전개(music-core clipWindows, 클립 끝 truncate)와 같은 의미로 반영한다.
// 마디 경계·음 경계에서 음을 나눠 붙임줄로 잇고, 빈 구간은 쉼표로 채운다.
// 표현할 수 없는 리듬·겹치는 성부·주법은 조용히 바꾸지 않고 진단(NotationDiagnostic)으로 남긴다.
//
// 음높이: pitch = 저장된 실제 음높이(sounding, tuning[stringIndex]+fret).
//        written = 베이스 오선보 표시 음높이 = sounding + 12 (베이스는 기보보다 한 옥타브 낮게 울린다).
// 현 순서: 원본 tuning 은 낮은 현→높은 현, stringIndex 0 = 가장 낮은 현. (렌더러 변환은 어댑터가 명시적으로 수행)
import type { Project, Id, Tick, TabSource, TabNote, MusicClip, Track } from '@bass-daw/schemas';
import { PPQ } from '@bass-daw/schemas';
import { MeterMap, TempoMap, clipWindows } from '@bass-daw/music-core';

export const BASS_WRITTEN_OCTAVE_SHIFT = 12;

export interface KeySignatureChoice { fifths: number; mode: 'major' | 'minor' }
export type StaveChoice = 'tab' | 'score' | 'both';
export interface NotationOptions { trackId: Id; startBar?: number; endBar?: number; key?: KeySignatureChoice; staves?: StaveChoice }

export type DiagLevel = 'error' | 'warn' | 'info';
export interface NotationDiagnostic { level: DiagLevel; code: string; message: string; bar?: number; noteIds?: Id[] }

export interface NotationNote {
  sourceNoteId: Id; clipId: Id; occurrence: number;
  stringIndex: number; fret: number;
  /** 저장된 실제 음높이(MIDI) */ pitch: number;
  /** 오선보 표시 음높이(MIDI) = pitch + 12 */ written: number;
  tieFromPrevious: boolean; tieToNext: boolean;
  slap: boolean; pop: boolean; dead: boolean;
  slideToNext: boolean; hammerOrPullToNext: 'hammer-on' | 'pull-off' | null;
}
export interface NotationBeat { tick: Tick; ticks: Tick; base: 1 | 2 | 4 | 8 | 16 | 32 | 64; dots: 0 | 1 | 2; rest: boolean; notes: NotationNote[]; text: string | null }
export interface NotationBar {
  number: number; startTick: Tick; ticks: Tick; numerator: number; denominator: number;
  tempo: { bpm: number; offsetTicks: Tick }[];
  beats: NotationBeat[];
  /** 표현 불가로 비워 둔 마디(진단 참조) */ unsupported: string | null;
}
export interface NotationScore {
  title: string; trackName: string;
  tuning: number[]; stringCount: number;
  writtenOctaveShift: number;
  key: KeySignatureChoice; staves: StaveChoice;
  startBar: number; endBar: number;
  bars: NotationBar[];
  diagnostics: NotationDiagnostic[];
}
export type NotationResult = { ok: true; score: NotationScore } | { ok: false; diagnostics: NotationDiagnostic[] };

/** 배치된 음(곡 tick) */
interface Placed {
  key: string; note: TabNote | null; clipId: Id; occurrence: number;
  stringIndex: number; fret: number; pitch: number;
  start: Tick; end: Tick; dead: boolean;
  slap: boolean; pop: boolean;
  slideTargetKey: string | null; legatoTargetKey: string | null; legatoKind: 'hammer-on' | 'pull-off' | null;
  tieIn: boolean; tieOut: boolean;
}

// 표현 가능한 음가(960 PPQ): 온음표=3840. 점 1·2 개까지. 64분음표(60 tick) 미만·셋잇단 등은 미지원.
const BASES = [1, 2, 4, 8, 16, 32, 64] as const;
const VALUES: { ticks: number; base: NotationBeat['base']; dots: NotationBeat['dots'] }[] = BASES.flatMap((b) => {
  const t = (PPQ * 4) / b;
  return [{ ticks: t, base: b, dots: 0 as const }, { ticks: t * 1.5, base: b, dots: 1 as const }, { ticks: t * 1.75, base: b, dots: 2 as const }];
}).filter((v) => Number.isInteger(v.ticks)).sort((a, b) => b.ticks - a.ticks);

/** 길이를 표현 가능한 음가들의 합으로 분해(큰 값 우선). 불가능하면 null. */
export function decomposeTicks(len: Tick): { ticks: number; base: NotationBeat['base']; dots: NotationBeat['dots'] }[] | null {
  const out: typeof VALUES = [];
  let rest = len;
  while (rest > 0) {
    const v = VALUES.find((x) => x.ticks <= rest && (rest - x.ticks) % 60 === 0);
    if (!v) return null;
    out.push(v); rest -= v.ticks;
  }
  return out;
}

const fifthsOk = (k: KeySignatureChoice) => Number.isInteger(k.fifths) && k.fifths >= -7 && k.fifths <= 7 && (k.mode === 'major' || k.mode === 'minor');

export function buildBassNotation(project: Project, opts: NotationOptions): NotationResult {
  const diags: NotationDiagnostic[] = [];
  const fail = (code: string, message: string): NotationResult => ({ ok: false, diagnostics: [...diags, { level: 'error', code, message }] });
  const track: Track | undefined = project.tracks.find((t) => t.id === opts.trackId);
  if (!track) return fail('TRACK_NOT_FOUND', 'track not found');
  if (track.kind !== 'tab') return fail('NOT_BASS_TAB', `track "${track.name}" is ${track.kind}; only bass TAB tracks can be exported`);
  const key = opts.key ?? { fifths: 0, mode: 'major' };
  if (!fifthsOk(key)) return fail('BAD_KEY', 'key signature must be -7..7 fifths, major|minor');
  const staves = opts.staves ?? 'both';

  const sources = new Map(project.sources.map((s) => [s.id, s]));
  const music = track.clips.filter((c): c is MusicClip => c.kind === 'music');
  let tuning: number[] | null = null;
  for (const c of music) {
    const s = sources.get(c.sourceId);
    if (!s || s.kind !== 'tab') return fail('NOT_BASS_TAB', `clip "${c.name}" does not reference a TAB source`);
    if (s.instrument !== 'bass') return fail('NOT_BASS_TAB', `clip "${c.name}" is a ${s.instrument} TAB; only bass is supported in this release`);
    if (s.tuning.length < 4 || s.tuning.length > 6) return fail('UNSUPPORTED_STRINGS', `${s.tuning.length}-string bass is not supported (4–6)`);
    if (tuning && tuning.join() !== s.tuning.join()) return fail('MIXED_TUNING', 'clips on this track use different tunings/string counts; one staff cannot show both');
    tuning = s.tuning;
  }
  if (!tuning) return fail('EMPTY_TRACK', 'track has no TAB clips');

  // ---------- 1. 배치(재생 전개와 같은 의미) ----------
  const placed: Placed[] = [];
  for (const c of music) {
    const src = sources.get(c.sourceId) as TabSource;
    if (c.muted) { diags.push({ level: 'info', code: 'CLIP_MUTED', message: `muted clip "${c.name}" is not printed (it does not play)` }); continue; }
    const clipEnd = c.startTick + c.durationTicks;
    for (const w of clipWindows(c, src.lengthTicks)) {
      const shift = w.clipStart - w.sourceStart;
      const k = (id: Id) => `${c.id}/${w.occurrence}/${id}`;
      for (const n of src.notes) {
        if (n.tick < w.sourceStart || n.tick >= w.sourceEnd) continue;
        const start = n.tick + shift;
        const end = Math.min(start + n.durationTicks, clipEnd);
        const slide = n.techniques.find((t) => t.kind === 'slide') as { targetNoteId: Id } | undefined;
        const leg = n.techniques.find((t) => t.kind === 'hammer-on' || t.kind === 'pull-off') as { kind: 'hammer-on' | 'pull-off'; targetNoteId: Id } | undefined;
        const bend = n.techniques.some((t) => t.kind === 'bend');
        if (bend) diags.push({ level: 'warn', code: 'UNSUPPORTED_TECHNIQUE', message: 'bend is not engraved in this release (note printed without bend)', noteIds: [n.id] });
        if (end < start + n.durationTicks) diags.push({ level: 'info', code: 'NOTE_TRUNCATED_BY_CLIP', message: 'note is cut at the clip end (as in playback)', noteIds: [n.id] });
        placed.push({
          key: k(n.id), note: n, clipId: c.id, occurrence: w.occurrence, stringIndex: n.stringIndex, fret: n.fret, pitch: src.tuning[n.stringIndex] + n.fret,
          start, end, dead: n.techniques.some((t) => t.kind === 'mute'),
          slap: n.techniques.some((t) => t.kind === 'slap'), pop: n.techniques.some((t) => t.kind === 'pop'),
          slideTargetKey: slide ? k(slide.targetNoteId) : null, legatoTargetKey: leg ? k(leg.targetNoteId) : null, legatoKind: leg?.kind ?? null,
          tieIn: false, tieOut: false,
        });
      }
      for (const s of src.strums) {
        if (s.tick < w.sourceStart || s.tick >= w.sourceEnd) continue;
        if (s.arpeggio) { diags.push({ level: 'error', code: 'UNSUPPORTED_ARPEGGIO', message: 'arpeggio pattern is not printed in this release (omitted)', noteIds: [s.id] }); continue; }
        if (s.spreadMs > 0) diags.push({ level: 'info', code: 'STRUM_SPREAD', message: `strum ${s.direction} spread ${s.spreadMs}ms printed as a plain chord`, noteIds: [s.id] });
        const start = s.tick + shift; const end = Math.min(start + s.durationTicks, clipEnd);
        for (const x of s.strings) placed.push({
          key: k(`${s.id}:${x.stringIndex}`), note: null, clipId: c.id, occurrence: w.occurrence, stringIndex: x.stringIndex, fret: x.fret ?? 0,
          pitch: src.tuning[x.stringIndex] + (x.fret ?? 0), start, end, dead: x.fret === null, slap: false, pop: false,
          slideTargetKey: null, legatoTargetKey: null, legatoKind: null, tieIn: false, tieOut: false,
        });
      }
    }
  }
  placed.sort((a, b) => a.start - b.start || a.stringIndex - b.stringIndex);

  // ---------- 2. 범위 ----------
  const mm = new MeterMap(project.meterMap);
  const tm = new TempoMap(project.tempoMap);
  const songEnd = Math.max(0, ...placed.map((p) => p.end), ...music.map((c) => c.startTick + c.durationTicks));
  const lastBar = Math.max(1, mm.tickToBarBeat(Math.max(0, songEnd - 1)).bar);
  const startBar = opts.startBar ?? 1;
  const endBar = opts.endBar ?? lastBar;
  if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || startBar < 1 || endBar < startBar) return fail('BAD_RANGE', `bar range ${startBar}–${endBar} is invalid`);
  if (endBar - startBar + 1 > 2000) return fail('BAD_RANGE', 'more than 2000 bars');
  const rangeStart = mm.barToTick(startBar), rangeEnd = mm.barToTick(endBar + 1);

  let inRange: Placed[] = [];
  for (const p of placed) {
    if (p.end <= rangeStart || p.start >= rangeEnd) continue;
    const q = { ...p };
    if (q.start < rangeStart) { q.start = rangeStart; q.tieIn = true; diags.push({ level: 'info', code: 'RANGE_TIE_IN', message: `note sounding into bar ${startBar} is printed from the range start without its tie origin`, bar: startBar, noteIds: p.note ? [p.note.id] : [] }); }
    if (q.end > rangeEnd) { q.end = rangeEnd; q.tieOut = true; diags.push({ level: 'info', code: 'RANGE_TIE_OUT', message: `note continues after bar ${endBar} (printed with an open tie)`, bar: endBar, noteIds: p.note ? [p.note.id] : [] }); }
    inRange.push(q);
  }
  // 같은 현 동시 발음(겹치는 클립 등): TAB 한 줄에 표기 불가 → 뒤 음을 제외하고 오류 진단
  const byString = new Map<number, Placed[]>();
  const kept: Placed[] = [];
  for (const p of inRange) {
    const list = byString.get(p.stringIndex) ?? [];
    const clash = list.find((o) => o.start < p.end && p.start < o.end);
    if (clash) { diags.push({ level: 'error', code: 'OVERLAPPING_SAME_STRING', message: `two notes overlap on string ${p.stringIndex + 1} (overlapping clips?); the later one is not printed`, bar: mm.tickToBarBeat(p.start).bar, noteIds: [clash.note?.id, p.note?.id].filter(Boolean) as Id[] }); continue; }
    list.push(p); byString.set(p.stringIndex, list); kept.push(p);
  }
  inRange = kept;
  // 서로 다른 시점에 시작·끝나는 겹침 = 다성부 → 붙임줄로 이은 화음 조각으로 표기(진단)
  for (let i = 0; i < inRange.length; i++) for (let j = i + 1; j < inRange.length; j++) {
    const a = inRange[i], b = inRange[j];
    if (b.start >= a.end) continue;
    if (a.start !== b.start || a.end !== b.end) {
      diags.push({ level: 'warn', code: 'OVERLAPPING_VOICES', message: 'overlapping notes with different start/end (multiple voices) are printed as one voice of tied chord segments', bar: mm.tickToBarBeat(b.start).bar, noteIds: [a.note?.id, b.note?.id].filter(Boolean) as Id[] });
    }
  }
  const keys = new Set(inRange.map((p) => p.key));

  // ---------- 3. 마디·조각·음가 ----------
  const bars: NotationBar[] = [];
  for (let bn = startBar; bn <= endBar; bn++) {
    const bs = mm.barToTick(bn), be = mm.barToTick(bn + 1);
    const meter = mm.meterAt(bs);
    const tempo: NotationBar['tempo'] = [];
    if (bn === startBar) tempo.push({ bpm: tm.bpmAt(bs), offsetTicks: 0 });
    for (const t of project.tempoMap) if (t.tick >= bs && t.tick < be && !(bn === startBar && t.tick === bs)) tempo.push({ bpm: t.bpm, offsetTicks: t.tick - bs });
    const notes = inRange.filter((p) => p.start < be && p.end > bs);
    const cuts = new Set<number>([bs, be]);
    for (const p of notes) { if (p.start > bs) cuts.add(p.start); if (p.end < be) cuts.add(p.end); }
    const pts = [...cuts].sort((a, b) => a - b);
    const beats: NotationBeat[] = [];
    let unsupported: string | null = null;
    for (let i = 0; i + 1 < pts.length && !unsupported; i++) {
      const a = pts[i], b = pts[i + 1];
      const sounding = notes.filter((p) => p.start <= a && p.end >= b).sort((x, y) => x.stringIndex - y.stringIndex);
      const parts = decomposeTicks(b - a);
      if (!parts) { unsupported = `segment of ${b - a} ticks at beat offset ${a - bs} cannot be written with plain/dotted values (tuplets are not supported)`; break; }
      let t = a;
      parts.forEach((v, pi) => {
        const isFirst = pi === 0, isLast = pi === parts.length - 1;
        const segEnd = t + v.ticks;
        if (sounding.length === 0) {
          beats.push({ tick: t, ticks: v.ticks, base: v.base, dots: v.dots, rest: true, notes: [], text: null });
        } else {
          beats.push({
            tick: t, ticks: v.ticks, base: v.base, dots: v.dots, rest: false, text: null,
            notes: sounding.map((p) => {
              // 범위 시작에서 잘린 음(tieIn)은 이어받을 앞 음이 없으므로 새 음처럼 시작하되 주법 기호는 원래 시작점 소유
              const startsHere = isFirst && p.start === a;
              const ownsStart = startsHere && !p.tieIn;
              const endsHere = isLast && p.end === b;
              return {
                sourceNoteId: p.note?.id ?? p.key.split('/')[2], clipId: p.clipId, occurrence: p.occurrence,
                stringIndex: p.stringIndex, fret: p.fret, pitch: p.pitch, written: p.pitch + BASS_WRITTEN_OCTAVE_SHIFT,
                tieFromPrevious: !startsHere,
                tieToNext: !endsHere || (p.tieOut && segEnd === p.end),
                slap: ownsStart && p.slap, pop: ownsStart && p.pop, dead: p.dead,
                slideToNext: endsHere && !!p.slideTargetKey && keys.has(p.slideTargetKey),
                hammerOrPullToNext: endsHere && p.legatoTargetKey && keys.has(p.legatoTargetKey) ? p.legatoKind : null,
              };
            }),
          });
        }
        t = segEnd;
      });
    }
    if (unsupported) {
      diags.push({ level: 'error', code: 'UNSUPPORTED_RHYTHM', message: `bar ${bn}: ${unsupported}; the bar is left empty with a warning`, bar: bn, noteIds: notes.map((p) => p.note?.id).filter(Boolean) as Id[] });
      const parts = decomposeTicks(be - bs) ?? [];
      beats.length = 0;
      let t = bs;
      parts.forEach((v, i) => { beats.push({ tick: t, ticks: v.ticks, base: v.base, dots: v.dots, rest: true, notes: [], text: i === 0 ? '⚠ 표기 불가 리듬' : null }); t += v.ticks; });
    }
    // 같은 beat 의 slap/pop 혼합은 alphaTab 에서 beat 단위 표기 → 진단
    for (const bt of beats) {
      const sl = bt.notes.filter((n) => n.slap).length, po = bt.notes.filter((n) => n.pop).length;
      if ((sl && sl < bt.notes.length) || (po && po < bt.notes.length)) diags.push({ level: 'warn', code: 'MIXED_BEAT_TECHNIQUE', message: `bar ${bn}: slap/pop applies to the whole chord in notation`, bar: bn });
    }
    // 연결 대상이 범위·클립 밖이면 기호 생략(진단)
    for (const p of notes) {
      if (p.end <= be && p.end > bs) {
        if (p.slideTargetKey && !keys.has(p.slideTargetKey)) diags.push({ level: 'warn', code: 'SLIDE_TARGET_OUTSIDE', message: `bar ${bn}: slide target is outside the printed range/clip; slide mark omitted`, bar: bn, noteIds: p.note ? [p.note.id] : [] });
        if (p.legatoTargetKey && !keys.has(p.legatoTargetKey)) diags.push({ level: 'warn', code: 'LEGATO_TARGET_OUTSIDE', message: `bar ${bn}: ${p.legatoKind} target is outside the printed range/clip; mark omitted`, bar: bn, noteIds: p.note ? [p.note.id] : [] });
      }
    }
    bars.push({ number: bn, startTick: bs, ticks: be - bs, numerator: meter.numerator, denominator: meter.denominator, tempo, beats, unsupported });
  }
  if (startBar !== 1) diags.push({ level: 'info', code: 'BAR_NUMBERS', message: `printing bars ${startBar}–${endBar}; the renderer's own bar numbers are hidden and the range is shown in the subtitle` });
  return { ok: true, score: { title: project.title, trackName: track.name, tuning: [...tuning], stringCount: tuning.length, writtenOctaveShift: BASS_WRITTEN_OCTAVE_SHIFT, key, staves, startBar, endBar, bars, diagnostics: dedupe(diags) } };
}

function dedupe(d: NotationDiagnostic[]): NotationDiagnostic[] {
  const seen = new Set<string>(); const out: NotationDiagnostic[] = [];
  for (const x of d) { const k = `${x.level}|${x.code}|${x.bar ?? ''}|${x.message}|${(x.noteIds ?? []).join()}`; if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/** 표시용 음이름(sharp 표기) — 진단/테스트 보조 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const pitchName = (p: number) => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

export * from './drums.ts';
