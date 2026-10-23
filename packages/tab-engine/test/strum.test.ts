import { describe, it, expect } from 'vitest';
import { expandStrum, compileTabSource, GUITAR_CHORDS } from '@bass-daw/tab-engine';
import { compilePlan } from '@bass-daw/audio-engine';
import { validateProject, serializeProject, deserializeProject, type TabSource, type TabStrum } from '@bass-daw/schemas';
import { ProjectSession } from '@bass-daw/project-core';
import { f00, FIXED_NOW } from '../../../tests/fixtures/projects.ts';

const guitar = (strums: TabStrum[], notes: TabSource['notes'] = []): TabSource => ({ id: 'g', kind: 'tab', lengthTicks: 3840 * 2, instrument: 'guitar', tuning: [40, 45, 50, 55, 59, 64], maxFret: 24, notes, strums });
const G = (o: Partial<TabStrum> = {}): TabStrum => ({ id: 's1', tick: 960, durationTicks: 960, chordName: 'G', strings: GUITAR_CHORDS.G.map((f, i) => ({ stringIndex: i, fret: f, velocity: 100 })), direction: 'down', spreadMs: 15, accent: 1, arpeggio: null, ...o });

describe('MVP-3 strum expansion', () => {
  it('down and up use reversed string order for the same fingering', () => {
    const d = expandStrum(guitar([]), G({ direction: 'down' })).map((e) => (e as { stringIndex: number }).stringIndex);
    const u = expandStrum(guitar([]), G({ direction: 'up' })).map((e) => (e as { stringIndex: number }).stringIndex);
    expect(d).toEqual([0, 1, 2, 3, 4, 5]);
    expect(u).toEqual([...d].reverse());
  });
  it('muted strings (x) are not sounded; unplayed strings omitted', () => {
    const s = G({ strings: [{ stringIndex: 0, fret: null, velocity: 100 }, { stringIndex: 1, fret: 3, velocity: 90 }, { stringIndex: 2, fret: 2, velocity: 80 }] });
    const ev = expandStrum(guitar([]), s);
    expect(ev.map((e) => (e as { stringIndex: number }).stringIndex)).toEqual([1, 2]);
    expect(ev.map((e) => (e as { pitch: number }).pitch)).toEqual([45 + 3, 50 + 2]);
  });
  it('spread 0 → simultaneous; spread N ms → frame within 1 sample of independent expectation', () => {
    const zero = expandStrum(guitar([]), G({ spreadMs: 0 }));
    expect(new Set(zero.map((e) => (e as { timeOffsetSeconds: number }).timeOffsetSeconds))).toEqual(new Set([0]));
    for (const sr of [44100, 48000, 96000]) {
      const s = new ProjectSession(f00()); s.clock = () => FIXED_NOW;
      s.run('t', { type: 'CreateTrack', kind: 'tab', instrument: 'guitar', trackId: 'tg', withClip: true });
      const clipId = s.project.tracks[0].clips[0].id;
      s.run('st', { type: 'EditNotes', clipId, ops: [{ op: 'add', collection: 'strums', item: G({ spreadMs: 17, tick: 960 }) }] });
      const plan = compilePlan(s.project, { sampleRate: sr, assetInfo: () => ({ sampleRate: sr, channels: 1 }) });
      if (!plan.ok) throw new Error(plan.message);
      const ons: number[] = [];
      for (let i = 0; i < plan.events.count; i++) if (plan.events.kind[i] === 1) ons.push(plan.events.frame[i]);
      // 독립 기대값: 120bpm 에서 tick 960 = 0.5s, k 번째 현 = 0.5 + k*0.017 s
      const expected = [0, 1, 2, 3, 4, 5].map((k) => (0.5 + k * 0.017) * sr);
      ons.forEach((f, k) => expect(Math.abs(f - expected[k])).toBeLessThanOrEqual(1));
    }
  });
  it('accent and per-string velocity combine and clamp to 1..127', () => {
    const s = G({ accent: 1.5, strings: [{ stringIndex: 1, fret: 0, velocity: 100 }, { stringIndex: 2, fret: 0, velocity: 40 }] });
    expect(expandStrum(guitar([]), s).map((e) => (e as { velocity: number }).velocity)).toEqual([127, 60]);
  });
  it('arpeggio follows order and rhythm in integer ticks, notes ring to strum end', () => {
    const s = G({ arpeggio: { order: [0, 2, 4, 5], stepTicks: 240 } });
    const ev = expandStrum(guitar([]), s) as { tick: number; durationTicks: number; stringIndex: number }[];
    expect(ev.map((e) => [e.stringIndex, e.tick, e.tick + e.durationTicks])).toEqual([[0, 960, 1920], [2, 1200, 1920], [4, 1440, 1920], [5, 1680, 1920]]);
  });
  it('fingering/direction/spread/accent/arpeggio survive validate → serialize → undo/redo', () => {
    const s = new ProjectSession(f00()); s.clock = () => FIXED_NOW;
    s.run('t', { type: 'CreateTrack', kind: 'tab', instrument: 'guitar', trackId: 'tg', withClip: true });
    const clipId = s.project.tracks[0].clips[0].id;
    const strum = G({ direction: 'up', spreadMs: 23, accent: 0.8, arpeggio: { order: [5, 3, 1], stepTicks: 120 } });
    s.run('st', { type: 'EditNotes', clipId, ops: [{ op: 'add', collection: 'strums', item: strum }] });
    expect(validateProject(s.project).ok).toBe(true);
    const bytes = serializeProject(s.project); if (!bytes.ok) throw new Error();
    const back = deserializeProject(bytes.value); if (!back.ok) throw new Error(JSON.stringify(back.errors));
    const src = back.value.sources.find((x) => x.kind === 'tab') as TabSource;
    expect(src.strums[0]).toEqual(strum);
    s.undo(); expect((s.project.sources.find((x) => x.kind === 'tab') as TabSource).strums).toEqual([]);
    s.redo(); expect((s.project.sources.find((x) => x.kind === 'tab') as TabSource).strums[0]).toEqual(strum);
  });
  it('strum string overlapping a TAB note on the same string is rejected', () => {
    const s = new ProjectSession(f00()); s.clock = () => FIXED_NOW;
    s.run('t', { type: 'CreateTrack', kind: 'tab', instrument: 'guitar', trackId: 'tg', withClip: true });
    const clipId = s.project.tracks[0].clips[0].id;
    s.run('n', { type: 'EditNotes', clipId, ops: [{ op: 'add', collection: 'notes', item: { id: 'n1', tick: 1000, durationTicks: 100, stringIndex: 1, fret: 0, velocity: 90, techniques: [] } }] });
    const r = s.run('st', { type: 'EditNotes', clipId, ops: [{ op: 'add', collection: 'strums', item: G() }] });
    expect(r.ok).toBe(false);
  });
  it('existing TAB/technique compile regression', () => {
    const src = guitar([], [{ id: 'a', tick: 0, durationTicks: 480, stringIndex: 0, fret: 5, velocity: 100, techniques: [{ kind: 'hammer-on', targetNoteId: 'b' }] }, { id: 'b', tick: 480, durationTicks: 480, stringIndex: 0, fret: 7, velocity: 100, techniques: [{ kind: 'bend', points: [{ offsetTick: 0, semitones: 0 }, { offsetTick: 240, semitones: 2 }] }] }]);
    const r = compileTabSource(src);
    const notes = r.events.filter((e) => e.kind === 'note') as { pitch: number; velocity: number; expressions: { value: number }[] }[];
    expect(notes.map((n) => n.pitch)).toEqual([45, 47]);
    expect(notes[1].velocity).toBe(60); // legato target soft re-attack
    expect(notes[1].expressions.at(-1)!.value).toBe(2);
    expect(r.diagnostics.map((d) => d.code)).toContain('ARTICULATION_FALLBACK');
  });
});
