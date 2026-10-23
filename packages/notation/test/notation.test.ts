// 기보 모델 변환 테스트. 기대값은 손으로 계산한 마디·음가·음높이(독립 오라클)이며 구현 결과를 복사하지 않는다.
import { describe, it, expect } from 'vitest';
import { buildBassNotation, decomposeTicks, pitchName, type NotationScore, type NotationBeat } from '@bass-daw/notation';
import { snapshotHash, validateProject } from '@bass-daw/schemas';
import { bassProject } from '../../../tests/fixtures/bass.ts';

const Q = 960, H = 1920, W = 3840, E = 480;
const ok = (r: ReturnType<typeof buildBassNotation>): NotationScore => { if (!r.ok) throw new Error(JSON.stringify(r.diagnostics)); return r.score; };
/** beat 요약: 'r4' 쉼표 4분, 'n2.' 점2분 음표, '~' 앞 붙임 '>' 뒤로 붙임 */
const sum = (b: NotationBeat) => `${b.rest ? 'r' : 'n'}${b.base}${'.'.repeat(b.dots)}${b.notes.some((n) => n.tieFromPrevious) ? '~' : ''}${b.notes.some((n) => n.tieToNext) ? '>' : ''}`;
const bars = (s: NotationScore) => s.bars.map((b) => b.beats.map(sum).join(' '));

describe('duration decomposition', () => {
  it('plain and dotted values; non-representable lengths are refused', () => {
    expect(decomposeTicks(W)?.map((v) => `${v.base}${'.'.repeat(v.dots)}`)).toEqual(['1']);
    expect(decomposeTicks(2880)?.map((v) => `${v.base}${'.'.repeat(v.dots)}`)).toEqual(['2.']);
    expect(decomposeTicks(Q + 60)?.map((v) => `${v.base}${'.'.repeat(v.dots)}`)).toEqual(['4', '64']);
    expect(decomposeTicks(320)).toBeNull(); // 8분 셋잇단
    expect(decomposeTicks(10)).toBeNull();
  });
});

describe('pitch: stored sounding pitch vs displayed (written) pitch; string order', () => {
  it('4/5/6-string and custom tunings', () => {
    const cases: [number[], number, number, number, string, string][] = [
      // tuning(낮→높), stringIndex, fret, 기대 sounding, 이름(sounding), 이름(written = +1 옥타브)
      [[28, 33, 38, 43], 0, 0, 28, 'E1', 'E2'],
      [[28, 33, 38, 43], 3, 5, 48, 'C3', 'C4'],
      [[23, 28, 33, 38, 43], 0, 0, 23, 'B0', 'B1'],
      [[23, 28, 33, 38, 43, 48], 5, 0, 48, 'C3', 'C4'],
      [[26, 33, 38, 43], 0, 2, 28, 'E1', 'E2'],    // drop D, 2프렛
      [[27, 32, 37, 42], 1, 0, 32, 'G#1', 'G#2'],  // 반음 내림
    ];
    for (const [tuning, si, fret, sounding, sName, wName] of cases) {
      const s = ok(buildBassNotation(bassProject({ tuning, notes: [[0, W, si, fret]] }), { trackId: 'trk-bass', endBar: 1 }));
      const n = s.bars[0].beats[0].notes[0];
      expect([n.pitch, pitchName(n.pitch), pitchName(n.written), n.stringIndex, s.stringCount]).toEqual([sounding, sName, wName, si, tuning.length]);
      expect(s.tuning).toEqual(tuning);
    }
  });
});

describe('bar splitting, ties, rests', () => {
  it('a half note starting on beat 4 is split at the bar line and tied; empty space becomes rests', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[3 * Q, H, 0, 3]] }), { trackId: 'trk-bass', endBar: 2 }));
    expect(bars(s)).toEqual(['r2. n4>', 'n4~ r2.']);
    expect(s.bars[1].beats[0].notes[0].fret).toBe(3);
  });
  it('long notes across several bars and odd lengths decompose into tied values', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[E, W + Q + E, 1, 0]] }), { trackId: 'trk-bass', endBar: 3 }));
    // 손 계산: 시작 480, 끝 480+5280=5760. 마디1: 8분 쉼표 + 3360(=겹점2분) / 마디2: 1920(2분, 끝) + 2분 쉼표 / 마디3: 온쉼표
    expect(bars(s)).toEqual(['r8 n2..>', 'n2~ r2', 'r1']);
  });
  it('empty bars inside the range are whole-bar rests with the bar length of the meter', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[0, Q, 0, 0]], meter: [{ tick: 0, numerator: 3, denominator: 4 }] }), { trackId: 'trk-bass', endBar: 2 }));
    expect(bars(s)).toEqual(['n4 r2', 'r2.']);
    expect(s.bars.map((b) => `${b.numerator}/${b.denominator}:${b.ticks}`)).toEqual(['3/4:2880', '3/4:2880']);
  });
});

describe('clip placement, trim and loop follow playback semantics', () => {
  it('offset + loop + truncation at clip end', () => {
    // source 2박: q(0) e-string fret1, q(960) fret2. 클립: 시작 마디2, 길이 5박, offset 1박, loop
    const p = bassProject({ notes: [[0, Q, 0, 1], [Q, Q, 0, 2]], sourceLength: H, clips: [{ startTick: W, durationTicks: 5 * Q - E, sourceOffsetTick: Q, loopSource: true }] });
    const s = ok(buildBassNotation(p, { trackId: 'trk-bass' }));
    // 재생 전개(손 계산): 클립 [3840,8160). 창 [960,1920)@3840 → fret2@3840 / [0,1920)@4800 → fret1@4800, fret2@5760 /
    // [0,1440)@6720 → fret1@6720, fret2@7680(source 960 < 1440) — 클립 끝 8160 에서 절단 → 8분
    const frets = s.bars.flatMap((b) => b.beats.filter((x) => !x.rest).map((x) => `${b.number}:${x.tick}:${x.notes[0].fret}:${x.ticks}`));
    expect(frets).toEqual(['2:3840:2:960', '2:4800:1:960', '2:5760:2:960', '2:6720:1:960', '3:7680:2:480']);
    expect(s.bars[1].beats.at(-1)!.notes[0].tieToNext).toBe(false);
    expect(bars(s)[2]).toBe('n8 r2..'); // 8분 + 남은 3360 = 겹점2분 쉼표
    expect(s.diagnostics.some((d) => d.code === 'NOTE_TRUNCATED_BY_CLIP')).toBe(true);
    expect(s.endBar).toBe(3);
  });
  it('muted clips are not printed and reported', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[0, Q, 0, 0]], clips: [{ muted: true }] }), { trackId: 'trk-bass', endBar: 1 }));
    expect(bars(s)).toEqual(['r1']);
    expect(s.diagnostics.map((d) => d.code)).toContain('CLIP_MUTED');
  });
});

describe('techniques', () => {
  it('slap / pop / slide / hammer-on / mute are carried; bend is reported', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [
      [0, Q, 0, 5, [{ kind: 'slap' }]], [Q, Q, 2, 7, [{ kind: 'pop' }]],
      [H, Q, 1, 2, [{ kind: 'slide', targetNoteId: 'n3' }]], [H + Q, Q, 1, 4, [], 'n3'],
      [W, Q, 0, 3, [{ kind: 'hammer-on', targetNoteId: 'n5' }]], [W + Q, Q, 0, 5, [], 'n5'],
      [W + H, Q, 1, 0, [{ kind: 'mute' }]], [W + H + Q, Q, 2, 2, [{ kind: 'bend', points: [{ offsetTick: 0, semitones: 0 }, { offsetTick: 480, semitones: 1 }] }]],
    ] }), { trackId: 'trk-bass', endBar: 2 }));
    const all = s.bars.flatMap((b) => b.beats).flatMap((b) => b.notes);
    expect(all.map((n) => [n.sourceNoteId, n.slap, n.pop, n.slideToNext, n.hammerOrPullToNext, n.dead])).toEqual([
      ['n0', true, false, false, null, false], ['n1', false, true, false, null, false],
      ['n2', false, false, true, null, false], ['n3', false, false, false, null, false],
      ['n4', false, false, false, 'hammer-on', false], ['n5', false, false, false, null, false],
      ['n6', false, false, false, null, true], ['n7', false, false, false, null, false],
    ]);
    expect(s.diagnostics.filter((d) => d.code === 'UNSUPPORTED_TECHNIQUE').map((d) => d.noteIds)).toEqual([['n7']]);
  });
  it('a slide whose target is outside the printed range is reported, not silently drawn', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[3 * Q, Q, 0, 2, [{ kind: 'slide', targetNoteId: 'x' }]], [W, Q, 0, 4, [], 'x']] }), { trackId: 'trk-bass', endBar: 1 }));
    expect(s.bars[0].beats.at(-1)!.notes[0].slideToNext).toBe(false);
    expect(s.diagnostics.map((d) => d.code)).toContain('SLIDE_TARGET_OUTSIDE');
  });
});

describe('unsupported content is diagnosed, never silently changed', () => {
  it('triplets: the bar is left empty with an error and a visible warning text', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[0, 320, 0, 0], [320, 320, 0, 1], [640, 320, 0, 2]] }), { trackId: 'trk-bass', endBar: 2 }));
    expect(s.bars[0].unsupported).toMatch(/320 ticks/);
    expect(s.bars[0].beats.every((b) => b.rest)).toBe(true);
    expect(s.bars[0].beats[0].text).toMatch(/표기 불가/);
    const d = s.diagnostics.find((x) => x.code === 'UNSUPPORTED_RHYTHM')!;
    expect([d.level, d.bar, d.noteIds]).toEqual(['error', 1, ['n0', 'n1', 'n2']]);
    expect(bars(s)[1]).toBe('r1');
  });
  it('overlapping voices are reported; same-string overlap (overlapping clips) is reported and the later note excluded', () => {
    const s = ok(buildBassNotation(bassProject({ notes: [[0, H, 0, 0], [Q, Q, 1, 2]] }), { trackId: 'trk-bass', endBar: 1 }));
    expect(s.diagnostics.find((d) => d.code === 'OVERLAPPING_VOICES')?.level).toBe('warn');
    expect(bars(s)).toEqual(['n4> n4~ r2']); // 2분음표 = 4분+4분(붙임), 둘째 조각에 n1 함께
    expect(s.bars[0].beats[1].notes.map((n) => n.sourceNoteId)).toEqual(['n0', 'n1']);
    const p = bassProject({ notes: [[0, Q, 0, 0]], clips: [{ startTick: 0 }, { startTick: 0, id: 'clipB' }] });
    const s2 = ok(buildBassNotation(p, { trackId: 'trk-bass', endBar: 1 }));
    expect(s2.diagnostics.find((d) => d.code === 'OVERLAPPING_SAME_STRING')?.level).toBe('error');
    expect(s2.bars[0].beats[0].notes.length).toBe(1);
  });
  it('non-bass tracks are refused (guitar TAB, MIDI)', () => {
    const g = buildBassNotation(bassProject({ instrument: 'guitar', tuning: [40, 45, 50, 55, 59, 64] }), { trackId: 'trk-bass' });
    expect(!g.ok && g.diagnostics[0].code).toBe('NOT_BASS_TAB');
    const p = bassProject(); p.tracks[0].kind = 'midi';
    expect(buildBassNotation(p, { trackId: 'trk-bass' }).ok).toBe(false);
  });
});

describe('range, tempo, meter, key', () => {
  it('bars 2–3 with tie-in/tie-out, tempo at range start and mid-bar, meter change, key choice', () => {
    const p = bassProject({
      notes: [[3 * Q, H, 0, 0], [W + H, Q, 1, 1], [2 * W, W + Q, 2, 2]],
      tempo: [{ tick: 0, bpm: 100, transition: 'step' }, { tick: W + H, bpm: 140, transition: 'step' }],
    });
    const s = ok(buildBassNotation(p, { trackId: 'trk-bass', startBar: 2, endBar: 3, key: { fifths: -3, mode: 'minor' }, staves: 'score' }));
    expect(bars(s)).toEqual(['n4 r4 n4 r4', 'n1>']);
    expect(s.bars[0].beats[0].notes[0].tieFromPrevious).toBe(false); // 이어받을 앞 음 없음
    expect(s.bars[0].tempo).toEqual([{ bpm: 100, offsetTicks: 0 }, { bpm: 140, offsetTicks: H }]);
    expect(s.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['RANGE_TIE_IN', 'RANGE_TIE_OUT', 'BAR_NUMBERS']));
    expect([s.key, s.staves, s.startBar, s.endBar]).toEqual([{ fifths: -3, mode: 'minor' }, 'score', 2, 3]);
    const bad = buildBassNotation(p, { trackId: 'trk-bass', key: { fifths: 9, mode: 'major' } });
    expect(bad.ok).toBe(false);
  });
});

describe('the original project is never modified', () => {
  it('canonical snapshot hash is identical before and after building notation', async () => {
    const p = bassProject({ notes: [[0, 320, 0, 0], [3 * Q, H, 0, 3, [{ kind: 'slap' }]], [W, Q, 1, 2, [{ kind: 'slide', targetNoteId: 'x' }]], [W + Q, Q, 1, 4, [], 'x']], clips: [{ loopSource: true, durationTicks: 3 * W }] });
    expect(validateProject(p).ok).toBe(true);
    const before = await snapshotHash(p), json = JSON.stringify(p);
    for (const o of [{}, { startBar: 2, endBar: 3 }, { key: { fifths: 2, mode: 'major' as const }, staves: 'tab' as const }]) buildBassNotation(p, { trackId: 'trk-bass', ...o });
    expect(await snapshotHash(p)).toBe(before);
    expect(JSON.stringify(p)).toBe(json);
  });
});
