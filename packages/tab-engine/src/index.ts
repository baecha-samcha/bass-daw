// TAB source → source-local 이벤트 어댑터. 원본 TabSource 는 읽기만 한다.
import type { TabSource, TabNote, TabStrum, Technique } from '@bass-daw/schemas';
import type { SourceEvent, SourceCompileResult, CompileDiagnostic } from '@bass-daw/music-core';

export const ARTICULATION_TECHNIQUES = ['mute', 'slap', 'pop'] as const;
/** 엔진이 연속 bend 를 표현하도록 expression 을 보내는 간격(tick) */
export const EXPRESSION_STEP_TICKS = 30;

export function notePitch(src: TabSource, stringIndex: number, fret: number): number {
  return src.tuning[stringIndex] + fret;
}

export function compileTabSource(src: TabSource): SourceCompileResult {
  const events: SourceEvent[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const byId = new Map(src.notes.map((n) => [n.id, n]));
  const legatoTargets = new Set<string>();
  for (const n of src.notes) for (const t of n.techniques) if (t.kind === 'hammer-on' || t.kind === 'pull-off') legatoTargets.add(t.targetNoteId);

  for (const n of src.notes) {
    const arts = n.techniques.filter((t) => (ARTICULATION_TECHNIQUES as readonly string[]).includes(t.kind)).map((t) => t.kind);
    if (arts.length > 1) diagnostics.push({ code: 'TECHNIQUE_COMBINED', sourceId: src.id, eventId: n.id, message: `${arts.join('+')} rendered as ${arts[0]}` });
    const expressions = expressionsFor(n, byId, diagnostics, src.id);
    let velocity = n.velocity;
    if (legatoTargets.has(n.id)) {
      // hammer-on/pull-off 대상: 재어택 대신 약한 어택으로 근사 — 실제 legato 샘플 없음을 진단
      velocity = Math.max(1, Math.round(n.velocity * 0.6));
      diagnostics.push({ code: 'ARTICULATION_FALLBACK', sourceId: src.id, eventId: n.id, message: 'hammer-on/pull-off target rendered as soft re-attack (no legato samples)' });
    }
    events.push({
      kind: 'note', id: n.id, tick: n.tick, durationTicks: n.durationTicks, pitch: notePitch(src, n.stringIndex, n.fret), velocity,
      channel: 0, articulation: arts[0] ?? 'normal', stringIndex: n.stringIndex, padId: null, timeOffsetSeconds: 0, expressions,
    });
  }
  for (const s of src.strums) events.push(...expandStrum(src, s));
  events.sort((a, b) => a.tick - b.tick);
  return { events, diagnostics };
}

function expressionsFor(n: TabNote, byId: Map<string, TabNote>, diags: CompileDiagnostic[], sourceId: string) {
  const out: { offsetTick: number; parameterId: string; value: number }[] = [];
  for (const t of n.techniques) {
    if (t.kind === 'bend') out.push(...sampleBend(t, n.durationTicks));
    if (t.kind === 'slide') {
      const target = byId.get(t.targetNoteId);
      if (!target) continue;
      // slide: 노트 마지막 1/4 동안 목표 프렛까지 pitch glide
      const semis = target.fret - n.fret;
      const start = Math.floor(n.durationTicks * 0.75);
      for (let o = start; o < n.durationTicks; o += EXPRESSION_STEP_TICKS) out.push({ offsetTick: o, parameterId: 'pitch.semitones', value: (semis * (o - start)) / (n.durationTicks - start) });
      diags.push({ code: 'ARTICULATION_FALLBACK', sourceId, eventId: n.id, message: 'slide rendered as pitch glide (no slide samples)' });
    }
  }
  return out;
}

/** bend points 사이를 선형 보간하여 EXPRESSION_STEP_TICKS 간격 expression 으로 전개 */
export function sampleBend(t: Extract<Technique, { kind: 'bend' }>, durationTicks: number) {
  const out: { offsetTick: number; parameterId: string; value: number }[] = [];
  const pts = t.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (!b) { out.push({ offsetTick: a.offsetTick, parameterId: 'pitch.semitones', value: a.semitones }); break; }
    for (let o = a.offsetTick; o < b.offsetTick; o += EXPRESSION_STEP_TICKS) {
      out.push({ offsetTick: o, parameterId: 'pitch.semitones', value: a.semitones + ((b.semitones - a.semitones) * (o - a.offsetTick)) / (b.offsetTick - a.offsetTick) });
    }
  }
  return out.filter((x) => x.offsetTick < durationTicks || x.offsetTick === 0);
}

/**
 * 스트로크 전개 (MVP-3 §8):
 *  - down: 낮은 현(index 0)→높은 현, up: 반대 순서. 뮤트(fret=null) 현은 발음하지 않지만 순서상 자리를 차지한다.
 *  - spreadMs: 연속 발음 현 사이 시간차. Tick 은 그대로 두고 timeOffsetSeconds 로 표현(frame 은 엔진이 계산).
 *  - arpeggio: order 순서대로 stepTicks 간격 Tick 배치, 각 음은 strum 끝까지 유지.
 *  - 현별 velocity × accent, 1..127 로 clamp.
 */
export function expandStrum(src: TabSource, s: TabStrum): SourceEvent[] {
  const out: SourceEvent[] = [];
  const end = s.tick + s.durationTicks;
  const vel = (v: number) => Math.max(1, Math.min(127, Math.round(v * s.accent)));
  if (s.arpeggio) {
    const byString = new Map(s.strings.map((x) => [x.stringIndex, x]));
    s.arpeggio.order.forEach((si, i) => {
      const x = byString.get(si);
      if (!x || x.fret === null) return;
      const tick = s.tick + i * s.arpeggio!.stepTicks;
      if (tick >= end) return;
      out.push({ kind: 'note', id: `${s.id}:${i}:${si}`, tick, durationTicks: end - tick, pitch: notePitch(src, si, x.fret), velocity: vel(x.velocity), channel: 0, articulation: 'normal', stringIndex: si, padId: null, timeOffsetSeconds: 0, expressions: [] });
    });
    return out;
  }
  const ordered = [...s.strings].sort((a, b) => (s.direction === 'down' ? a.stringIndex - b.stringIndex : b.stringIndex - a.stringIndex));
  let k = 0;
  for (const x of ordered) {
    if (x.fret === null) continue;
    out.push({ kind: 'note', id: `${s.id}:${x.stringIndex}`, tick: s.tick, durationTicks: s.durationTicks, pitch: notePitch(src, x.stringIndex, x.fret), velocity: vel(x.velocity), channel: 0, articulation: 'normal', stringIndex: x.stringIndex, padId: null, timeOffsetSeconds: (k * s.spreadMs) / 1000, expressions: [] });
    k++;
  }
  return out;
}

/** 자주 쓰는 오픈 코드 (현 index 0=저음 E). null=뮤트 */
export const GUITAR_CHORDS: Record<string, (number | null)[]> = {
  C: [null, 3, 2, 0, 1, 0], G: [3, 2, 0, 0, 0, 3], D: [null, null, 0, 2, 3, 2], A: [null, 0, 2, 2, 2, 0],
  E: [0, 2, 2, 1, 0, 0], Am: [null, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [null, null, 0, 2, 3, 1], F: [1, 3, 3, 2, 1, 1],
};
