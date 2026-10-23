import { describe, it, expect } from 'vitest';
import { TempoMap, MeterMap, expandClip, clipWindows } from '@bass-daw/music-core';
import type { SourceEvent } from '@bass-daw/music-core';
import type { MusicClip } from '@bass-daw/schemas';
import { oracleFrame } from '../../../tests/fixtures/oracle.ts';

const F01_TEMPO = [{ tick: 0, bpm: 120 }, { tick: 3840, bpm: 90 }, { tick: 7680, bpm: 173 }];

describe('A01 tempo integration (independent oracle)', () => {
  const tm = new TempoMap(F01_TEMPO.map((t) => ({ ...t, transition: 'step' as const })));
  it('F01 positions 0/1/959/960/961 and around tempo changes within ≤1 frame', () => {
    const ticks = [0, 1, 959, 960, 961, 3839, 3840, 3841, 7679, 7680, 7681, 100_000, 1_234_567];
    for (const sr of [44100, 48000, 96000]) {
      for (const t of ticks) {
        const e = oracleFrame(F01_TEMPO, t, sr);
        expect(Math.abs(tm.tickToFrame(t, sr) - e)).toBeLessThanOrEqual(1);
      }
    }
  });
  it('exact values at 120bpm/48k', () => {
    expect(tm.tickToFrame(960, 48000)).toBe(24000);
    expect(tm.tickToSeconds(3840)).toBe(2);
    expect(tm.tickToSeconds(3840 + 960)).toBeCloseTo(2 + 60 / 90, 12);
  });
  it('inverse returns real tick', () => {
    for (const t of [0, 1, 959.5, 3840, 5000.25, 9000]) expect(tm.secondsToTick(tm.tickToSeconds(t))).toBeCloseTo(t, 6);
  });
  it('long timeline (30 min) error stays ≤1 frame', () => {
    const t = new TempoMap([{ tick: 0, bpm: 120, transition: 'step' }]);
    const last = 30 * 60 * 2 * 960;
    expect(Math.abs(t.tickToFrame(last, 48000) - oracleFrame([{ tick: 0, bpm: 120 }], last, 48000))).toBeLessThanOrEqual(1);
  });
});

describe('meter map', () => {
  const mm = new MeterMap([{ tick: 0, numerator: 4, denominator: 4 }, { tick: 3840 * 2, numerator: 3, denominator: 4 }, { tick: 3840 * 2 + 2880, numerator: 7, denominator: 8 }]);
  it('bar/beat', () => {
    expect(mm.tickToBarBeat(0)).toEqual({ bar: 1, beat: 1, tickInBeat: 0 });
    expect(mm.tickToBarBeat(3840 * 2)).toEqual({ bar: 3, beat: 1, tickInBeat: 0 });
    expect(mm.tickToBarBeat(3840 * 2 + 960 * 2 + 5)).toEqual({ bar: 3, beat: 3, tickInBeat: 5 });
    expect(mm.tickToBarBeat(3840 * 2 + 2880 + 480)).toEqual({ bar: 4, beat: 2, tickInBeat: 0 });
    expect(mm.barToTick(4)).toBe(3840 * 2 + 2880);
    expect(mm.barLines(0, 3840 * 2 + 2880 + 1)).toEqual([0, 3840, 7680, 10560]);
  });
});

const note = (id: string, tick: number, dur: number): SourceEvent => ({ kind: 'note', id, tick, durationTicks: dur, pitch: 60, velocity: 100, channel: 0, articulation: 'normal', stringIndex: null, padId: null, timeOffsetSeconds: 0, expressions: [] });
const clip = (o: Partial<MusicClip>): MusicClip => ({ id: 'c', kind: 'music', sourceId: 's', name: '', muted: false, startTick: 0, durationTicks: 960, sourceOffsetTick: 0, loopSource: false, ...o });

describe('S05 trim/loop half-open intervals', () => {
  const ev = [note('a', 0, 480), note('b', 480, 960), note('c', 959, 10), note('d', 960, 100), note('e', 1800, 120)];
  it('non-loop trim: only notes starting in [offset, offset+dur) emit; end truncated at clip end', () => {
    const out = expandClip('t', clip({ startTick: 1000, sourceOffsetTick: 480, durationTicks: 480 }), 's', 1920, ev);
    const ons = out.filter((e) => e.kind === 'noteOn').map((e) => [e.sourceEventId, e.tick]);
    expect(ons).toEqual([['b', 1000], ['c', 1479]]);
    const offs = out.filter((e) => e.kind === 'noteOff').map((e) => [e.sourceEventId, e.tick]);
    expect(offs).toEqual([['b', 1480], ['c', 1480]]); // b truncated (1000+960 → 1480), c truncated 1489→1480
  });
  it('note starting exactly at clip end is excluded; at clip start included', () => {
    const out = expandClip('t', clip({ startTick: 0, sourceOffsetTick: 0, durationTicks: 960 }), 's', 1920, ev);
    expect(out.filter((e) => e.kind === 'noteOn').map((e) => e.sourceEventId)).toEqual(['a', 'b', 'c']);
  });
  it('loop wraps with occurrence; no duplicates/omissions across wrap', () => {
    const c = clip({ startTick: 0, sourceOffsetTick: 960, durationTicks: 1920 * 2, loopSource: true });
    expect(clipWindows(c, 1920)).toEqual([
      { clipStart: 0, sourceStart: 960, sourceEnd: 1920, occurrence: 0 },
      { clipStart: 960, sourceStart: 0, sourceEnd: 1920, occurrence: 1 },
      { clipStart: 2880, sourceStart: 0, sourceEnd: 960, occurrence: 2 },
    ]);
    const ons = expandClip('t', c, 's', 1920, ev).filter((e) => e.kind === 'noteOn').map((e) => `${e.sourceEventId}@${e.tick}#${e.occurrence}`);
    expect(ons).toEqual(['d@0#0', 'e@840#0', 'a@960#1', 'b@1440#1', 'c@1919#1', 'd@1920#1', 'e@2760#1', 'a@2880#2', 'b@3360#2', 'c@3839#2']);
    // voiceKey 유일
    const keys = expandClip('t', c, 's', 1920, ev).filter((e) => e.kind === 'noteOn').map((e) => (e as { voiceKey: string }).voiceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('muted clip emits nothing', () => {
    expect(expandClip('t', clip({ muted: true }), 's', 1920, ev)).toEqual([]);
  });
});
