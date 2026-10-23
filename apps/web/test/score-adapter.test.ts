// alphaTab 1.8.4 데이터 모델 변환 검증(Node). 실제 브라우저 렌더링·인쇄는 tests/e2e/score.spec.ts.
import { describe, it, expect } from 'vitest';
import * as at from '@coderline/alphatab';
import { buildBassNotation, type NotationScore } from '@bass-daw/notation';
import { toAlphaTabScore, toAlphaTabString, toAlphaTabTunings } from '../src/score/alphatab-adapter.ts';
import { bassProject, type N } from '../../../tests/fixtures/bass.ts';

const Q = 960, W = 3840;
function convert(notes: N[], o: Parameters<typeof bassProject>[0] = {}, n: Partial<Parameters<typeof buildBassNotation>[1]> = {}) {
  const r = buildBassNotation(bassProject({ notes, ...o }), { trackId: 'trk-bass', ...n });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  const score = toAlphaTabScore(at, r.score);
  score.finish(new at.Settings());
  return { score, ns: r.score as NotationScore, notes: score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).flatMap((b) => b.notes) };
}

describe('explicit string-order and tuning conversion', () => {
  it('stringIndex 0 (lowest) ↔ alphaTab string 1 (lowest); tuning low→high ↔ high→low', () => {
    expect(toAlphaTabString(0)).toBe(1);
    expect(toAlphaTabTunings([28, 33, 38, 43])).toEqual([43, 38, 33, 28]);
    for (const tuning of [[28, 33, 38, 43], [23, 28, 33, 38, 43], [23, 28, 33, 38, 43, 48], [26, 33, 38, 43]]) {
      const notes: N[] = tuning.map((_, i) => [i * Q, Q, i, i + 1]);
      const { score, notes: an } = convert(notes, { tuning }, { endBar: tuning.length > 4 ? 2 : 1 });
      const st = score.tracks[0].staves[0];
      expect(st.stringTuning.tunings).toEqual([...tuning].reverse());
      expect(st.tuning).toEqual([...tuning].reverse());
      // alphaTab 이 계산한 실제 음 = 원본 tuning[stringIndex] + fret (독립 계산)
      expect(an.map((x) => x.realValue)).toEqual(tuning.map((t, i) => t + i + 1));
      expect(an.map((x) => x.string)).toEqual(tuning.map((_, i) => i + 1));
    }
  });
  it('display pitch is one octave above the stored sounding pitch (bass 8vb convention)', () => {
    const { notes: an, ns } = convert([[0, W, 0, 0]], {}, { endBar: 1 });
    expect([an[0].realValue, an[0].displayValue]).toEqual([28, 40]);
    expect(ns.bars[0].beats[0].notes[0].written).toBe(an[0].displayValue);
  });
});

describe('rhythm, ties, techniques, key, tempo in the alphaTab model', () => {
  it('ties across the bar line are resolved to an origin; durations/dots/rests mapped', () => {
    const { score, notes: an } = convert([[3 * Q, 2 * Q, 1, 3]], {}, { endBar: 2 });
    const beats = score.tracks[0].staves[0].bars.map((b) => b.voices[0].beats.map((x) => `${x.isRest ? 'r' : 'n'}${x.duration}${'.'.repeat(x.dots)}`).join(' '));
    expect(beats).toEqual(['r2. n4', 'n4 r2.']);
    expect(an[1].isTieDestination).toBe(true);
    expect(an[1].tieOrigin).toBe(an[0]);
    expect(an[0].tieDestination).toBe(an[1]);
  });
  it('slap/pop on beats, shift slide resolved to the next note on the string, hammer-on, dead note', () => {
    const { score, notes: an } = convert([
      [0, Q, 0, 5, [{ kind: 'slap' }]], [Q, Q, 2, 7, [{ kind: 'pop' }]],
      [2 * Q, Q, 1, 2, [{ kind: 'slide', targetNoteId: 't' }]], [3 * Q, Q, 1, 4, [], 't'],
      [W, Q, 0, 3, [{ kind: 'hammer-on', targetNoteId: 'h' }]], [W + Q, Q, 0, 5, [], 'h'], [W + 2 * Q, Q, 1, 0, [{ kind: 'mute' }]],
    ], {}, { endBar: 2 });
    const beats = score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).filter((b) => !b.isRest);
    expect(beats.map((b) => [b.slap, b.pop])).toEqual([[true, false], [false, true], [false, false], [false, false], [false, false], [false, false], [false, false]]);
    expect(an[2].slideOutType).toBe(at.model.SlideOutType.Shift);
    expect(an[2].slideTarget).toBe(an[3]);
    expect(an[4].isHammerPullOrigin).toBe(true);
    expect(an[4].hammerPullDestination).toBe(an[5]);
    expect(an[6].isDead).toBe(true);
  });
  it('user key signature and tempo (start + mid-bar change) on master bars', () => {
    const { score } = convert([[0, Q, 0, 0]], { tempo: [{ tick: 0, bpm: 96, transition: 'step' }, { tick: 2 * Q, bpm: 132, transition: 'step' }] }, { endBar: 2, key: { fifths: 2, mode: 'minor' } });
    const bar = score.tracks[0].staves[0].bars[0];
    expect([bar.keySignature, bar.keySignatureType, bar.clef]).toEqual([2, at.model.KeySignatureType.Minor, at.model.Clef.F4]);
    expect(score.masterBars[0].tempoAutomations.map((a) => [a.value, a.ratioPosition])).toEqual([[96, 0], [132, 0.5]]);
  });
  it('stave choice maps to TAB / standard notation flags', () => {
    for (const [st, tab, std] of [['tab', true, false], ['score', false, true], ['both', true, true]] as const) {
      const { score } = convert([[0, Q, 0, 0]], {}, { endBar: 1, staves: st });
      expect([score.tracks[0].staves[0].showTablature, score.tracks[0].staves[0].showStandardNotation]).toEqual([tab, std]);
    }
  });
});
