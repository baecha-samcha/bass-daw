import { describe, it, expect } from 'vitest';
import { validateProject, serializeProject, deserializeProject, canonicalStringify, sha256HexSync, sha256Hex, snapshotHash, migrate, findRoutingCycle } from '@bass-daw/schemas';
import type { Project } from '@bass-daw/schemas';
import { f00, f03, deepFreeze } from '../../../tests/fixtures/projects.ts';
import { rng } from '../../../tests/fixtures/ids.ts';
import { createHash } from 'node:crypto';

const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sha256 (독립 오라클: node:crypto)', () => {
  it('matches node for edge lengths', () => {
    const r = rng(1);
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65537]) {
      const b = new Uint8Array(n).map(() => Math.floor(r() * 256));
      expect(sha256HexSync(b)).toBe(nodeSha(b));
    }
  });
  it('incremental chunks equal one-shot', async () => {
    const b = new Uint8Array(200_003).map((_, i) => (i * 31) & 255);
    expect(await sha256Hex(b)).toBe(nodeSha(b));
  });
});

describe('S01 canonical round trip', () => {
  it('F00 empty project with master', () => {
    const p = f00();
    expect(validateProject(p).ok).toBe(true);
    const bytes = serializeProject(p);
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) return;
    const back = deserializeProject(bytes.value);
    expect(back.ok && back.value).toEqual(p);
  });
  it('F03 every source/clip kind round trips with identical bytes, ids and dates', async () => {
    const p = deepFreeze(f03());
    const v = validateProject(p);
    if (!v.ok) console.log(v.errors);
    expect(v.ok).toBe(true);
    const a = serializeProject(p);
    if (!a.ok) throw new Error('serialize');
    const back = deserializeProject(a.value);
    if (!back.ok) throw new Error(JSON.stringify(back.errors));
    expect(back.value).toEqual(p);
    const b = serializeProject(back.value);
    if (!b.ok) throw new Error('serialize2');
    expect(nodeSha(b.value)).toBe(nodeSha(a.value));
    expect(back.value.createdAt).toBe(p.createdAt);
    expect(back.value.updatedAt).toBe(p.updatedAt);
    expect(await snapshotHash(back.value)).toBe(nodeSha(a.value));
  });
  it('canonical: sorted keys, -0 → 0, array order kept', () => {
    expect(canonicalStringify({ b: [3, 1, 2], a: -0, c: { z: 1, y: 'é' } })).toBe('{"a":0,"b":[3,1,2],"c":{"y":"é","z":1}}');
  });
});

describe('S03 preservation', () => {
  it('동음이현, techniques, CC, pitch bend, unknown plugin state survive', () => {
    const p = f03();
    const bytes = serializeProject(p);
    if (!bytes.ok) throw new Error();
    const back = deserializeProject(bytes.value);
    if (!back.ok) throw new Error();
    const tab = back.value.sources.find((s) => s.kind === 'tab')!;
    if (tab.kind !== 'tab') throw new Error();
    const pitches = tab.notes.map((n) => tab.tuning[n.stringIndex] + n.fret);
    expect(pitches.filter((x) => x === 33).length).toBe(2);
    expect(tab.notes.find((n) => n.techniques.some((t) => t.kind === 'bend'))!.techniques[0]).toEqual({ kind: 'bend', points: [{ offsetTick: 0, semitones: 0 }, { offsetTick: 480, semitones: 1 }, { offsetTick: 960, semitones: 0.5 }] });
    const midi = back.value.sources.find((s) => s.kind === 'midi')!;
    if (midi.kind !== 'midi') throw new Error();
    expect(midi.cc.map((c) => [c.controller, c.value])).toEqual([[64, 127], [64, 0]]);
    expect(midi.pitchBend.map((c) => c.value)).toEqual([-8192, 8191]);
    const unknown = back.value.plugins.find((x) => x.pluginId === 'com.example.unknown-drums')!;
    expect(unknown.state).toEqual({ kit: 'vintage', nested: { a: [1, 2, { b: null }] }, future: true });
    expect(unknown.parameters).toEqual({ 'tone.color': 0.25 });
    expect(back.value.automation[1].target.ownerId).toBe(unknown.instanceId);
  });
});

// ---------- S02: seeded invalid generator ----------
type Mut = (p: Project, r: () => number) => void;
const pick = <T,>(a: T[], r: () => number) => a[Math.floor(r() * a.length)];
const tab = (p: Project) => p.sources.find((s) => s.kind === 'tab') as Extract<Project['sources'][number], { kind: 'tab' }>;
const midi = (p: Project) => p.sources.find((s) => s.kind === 'midi') as Extract<Project['sources'][number], { kind: 'midi' }>;
const drum = (p: Project) => p.sources.find((s) => s.kind === 'drum') as Extract<Project['sources'][number], { kind: 'drum' }>;
const big = (r: () => number) => 128 + Math.floor(r() * 1e6);
const MUTATIONS: [string, Mut][] = [
  ['unknown core field', (p, r) => { (p as unknown as Record<string, unknown>)['x' + Math.floor(r() * 1e6)] = 1; }],
  ['unknown track field', (p) => { (p.tracks[0] as unknown as Record<string, unknown>).extra = true; }],
  ['wrong format', (p) => { (p as { format: string }).format = 'other'; }],
  ['wrong ppq', (p, r) => { (p as { ppq: number }).ppq = 480 + Math.floor(r() * 10); }],
  ['negative tick', (p, r) => { tab(p).notes[0].tick = -1 - Math.floor(r() * 100); }],
  ['fractional tick', (p, r) => { midi(p).notes[0].tick = 0.5 + Math.floor(r() * 100); }],
  ['NaN number', (p) => { p.channels[1].gain = NaN; }],
  ['Infinity', (p) => { p.channels[1].pan = Infinity; }],
  ['gain range', (p, r) => { p.channels[1].gain = 4.0001 + r() * 10; }],
  ['pan range', (p, r) => { p.channels[1].pan = -1.0001 - r(); }],
  ['velocity 0', (p) => { midi(p).notes[0].velocity = 0; }],
  ['velocity >127', (p, r) => { midi(p).notes[0].velocity = big(r); }],
  ['pitch >127', (p, r) => { midi(p).notes[0].pitch = big(r); }],
  ['channel 16', (p, r) => { midi(p).notes[0].channel = 16 + Math.floor(r() * 10); }],
  ['bend range', (p, r) => { midi(p).pitchBend[0].value = -8193 - Math.floor(r() * 100); }],
  ['cc range', (p, r) => { midi(p).cc[0].value = big(r); }],
  ['note past source end', (p, r) => { midi(p).notes[2].durationTicks = 841 + Math.floor(r() * 1000); }],
  ['zero duration', (p) => { tab(p).notes[3].durationTicks = 0; }],
  ['string overlap', (p, r) => { tab(p).notes[1].tick = 1 + Math.floor(r() * 470); tab(p).notes[0].techniques = []; }],
  ['fret > maxFret', (p, r) => { tab(p).notes[3].fret = 25 + Math.floor(r() * 11); }],
  ['string out of tuning', (p) => { tab(p).notes[3].stringIndex = 4; }],
  ['bass 3 strings', (p) => { tab(p).tuning = [28, 33, 38]; tab(p).notes = tab(p).notes.filter((n) => n.stringIndex < 3); }],
  ['hammer-on lower fret', (p) => { tab(p).notes[1].fret = 4; tab(p).notes[1].techniques = []; }],
  ['self link', (p) => { tab(p).notes[0].techniques = [{ kind: 'slide', targetNoteId: tab(p).notes[0].id }]; }],
  ['broken link', (p, r) => { tab(p).notes[0].techniques = [{ kind: 'hammer-on', targetNoteId: 'missing-' + Math.floor(r() * 1e6) }]; }],
  ['link not adjacent', (p) => { tab(p).notes[0].durationTicks = 240; }],
  ['two links', (p) => { tab(p).notes[0].techniques.push({ kind: 'slide', targetNoteId: tab(p).notes[1].id }); }],
  ['bend not from 0', (p) => { (tab(p).notes[2].techniques[0] as { points: { offsetTick: number }[] }).points[0].offsetTick = 10; }],
  ['bend semitone range', (p, r) => { (tab(p).notes[2].techniques[0] as { points: { semitones: number }[] }).points[1].semitones = 12.5 + r() * 5; }],
  ['bend past duration', (p) => { (tab(p).notes[2].techniques[0] as { points: { offsetTick: number }[] }).points[2].offsetTick = 961; }],
  ['duplicate id (note vs track)', (p) => { midi(p).notes[0].id = p.tracks[0].id; }],
  ['duplicate id (clip)', (p) => { p.tracks[1].clips[0].id = p.tracks[0].clips[0].id; }],
  ['broken source ref', (p, r) => { p.tracks[0].clips[0].sourceId = 'nope' + Math.floor(r() * 1e6); }],
  ['kind mismatch', (p) => { p.tracks[1].clips[0].sourceId = tab(p).id; }],
  ['nonloop exceeds source', (p, r) => { (p.tracks[0].clips[1] as { sourceOffsetTick: number }).sourceOffsetTick = 1921 + Math.floor(r() * 1000); }],
  ['loop offset >= length', (p) => { (p.tracks[2].clips[0] as { sourceOffsetTick: number }).sourceOffsetTick = 1920; }],
  ['audio selection exceeds', (p, r) => { (p.tracks[3].clips[0] as { sourceFrameCount: number }).sourceFrameCount = 47001 + Math.floor(r() * 1000); }],
  ['fades exceed', (p) => { (p.tracks[3].clips[0] as { fadeInFrames: number }).fadeInFrames = 39100; }],
  ['routing cycle via send', (p) => { p.channels.find((c) => c.kind === 'bus')!.sends.push({ id: 'cyc-send', targetChannelId: p.channels.find((c) => c.kind === 'bus')!.id, gain: 1, tap: 'post' }); }],
  ['routing cycle 2 buses', (p) => { const b2 = { id: 'bus2', kind: 'bus' as const, name: 'b2', gain: 1, pan: 0, muted: false, solo: false, output: p.channels.find((c) => c.kind === 'bus')!.id, effects: [], sends: [] }; p.channels.push(b2); p.channels.find((c) => c.kind === 'bus')!.output = 'bus2'; }],
  ['output to track channel', (p) => { p.channels[2].output = p.channels[1].id; }],
  ['master has output', (p) => { p.channels[0].output = p.channels[5].id; }],
  ['two masters', (p) => { p.channels.push({ ...p.channels[0], id: 'm2' }); }],
  ['effect slot is instrument', (p) => { p.channels[1].effects = [p.plugins[0].instanceId]; }],
  ['plugin in two slots', (p) => { p.tracks[1].instrumentSlot = p.tracks[0].instrumentSlot; }],
  ['audio track instrument', (p) => { p.tracks[3].instrumentSlot = p.plugins[1].instanceId; p.tracks[1].instrumentSlot = null; }],
  ['tempo missing tick 0', (p) => { p.tempoMap[0].tick = 10; }],
  ['tempo bpm range', (p, r) => { p.tempoMap[0].bpm = 401 + r() * 100; }],
  ['tempo not ascending', (p) => { p.tempoMap.push({ tick: 0, bpm: 100, transition: 'step' }); }],
  ['meter off bar', (p, r) => { p.meterMap.push({ tick: 1 + Math.floor(r() * 3838), numerator: 3, denominator: 4 }); }],
  ['meter denominator', (p) => { (p.meterMap[0] as { denominator: number }).denominator = 3; }],
  ['loop end <= start', (p) => { p.loop.endTick = p.loop.startTick; }],
  ['updatedAt < createdAt', (p) => { p.updatedAt = '2020-01-01T00:00:00.000Z'; }],
  ['bad date', (p) => { p.createdAt = '2026-10-22 00:00'; }],
  ['automation not ascending', (p) => { p.automation[0].points[1].tick = 0; }],
  ['automation value range', (p, r) => { p.automation[0].points[0].value = 4.5 + r(); }],
  ['automation unknown channel param', (p) => { p.automation[0].target.parameterId = 'width'; }],
  ['automation duplicate target', (p) => { p.automation.push({ ...p.automation[0], id: 'dup-lane' }); }],
  ['automation broken owner', (p) => { p.automation[0].target.ownerId = 'ghost'; }],
  ['hit unknown pad', (p) => { drum(p).hits[0].padId = 'ghost-pad'; }],
  ['asset bad sha', (p) => { p.assets[0].sha256 = 'A'.repeat(64); }],
  ['asset 3 channels', (p) => { p.assets[0].audio!.channels = 3; }],
  ['asset sample rate', (p, r) => { p.assets[0].audio!.sampleRate = 7999 - Math.floor(r() * 1000); }],
  ['audio source w/o audio meta', (p) => { (p.sources.find((s) => s.kind === 'audio') as { assetId: string }).assetId = p.assets[1].id; }],
  ['title too long', (p, r) => { p.title = 'x'.repeat(257 + Math.floor(r() * 100)); }],
  ['builtin param out of range', (p) => { p.plugins[3].parameters['band1.gainDb'] = 30; }],
  ['tick overflow', (p) => { (p.tracks[0].clips[0] as { startTick: number }).startTick = Number.MAX_SAFE_INTEGER; }],
  ['missing field', (p) => { delete (p as unknown as Record<string, unknown>).loop; }],
  ['null tracks', (p) => { (p as unknown as Record<string, unknown>).tracks = null; }],
  ['track channel orphan', (p) => { p.channels.push({ id: 'orphan', kind: 'track', name: 'o', gain: 1, pan: 0, muted: false, solo: false, output: p.masterChannelId, effects: [], sends: [] }); }],
];

describe('S02 invalid generated inputs are rejected and originals untouched', () => {
  it('10,000 seeded cases', async () => {
    const base = deepFreeze(f03());
    const baseHash = sha256HexSync(new TextEncoder().encode(canonicalStringify(base)));
    const r = rng();
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const [name, m] = pick(MUTATIONS, r);
      const c = structuredClone(base) as Project;
      m(c, r);
      const res = validateProject(c);
      if (res.ok) throw new Error(`mutation accepted: ${name}`);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0].path.startsWith('$')).toBe(true);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect(counts.size).toBe(MUTATIONS.length);
    expect(sha256HexSync(new TextEncoder().encode(canonicalStringify(base)))).toBe(baseHash);
  });
  it('error codes', () => {
    const p = structuredClone(f03()) as Project;
    p.tracks[1].clips[0].id = p.tracks[0].clips[0].id;
    const r = validateProject(p);
    expect(!r.ok && r.errors.some((e) => e.code === 'DUPLICATE_ID')).toBe(true);
    const q = structuredClone(f03()) as Project;
    q.channels.find((c) => c.kind === 'bus')!.sends.push({ id: 'z', targetChannelId: q.channels[1].id, gain: 1, tap: 'pre' });
    expect(validateProject(q).ok).toBe(false);
    expect(findRoutingCycle([{ id: 'a', kind: 'bus', name: '', gain: 1, pan: 0, muted: false, solo: false, output: 'b', effects: [], sends: [] }, { id: 'b', kind: 'bus', name: '', gain: 1, pan: 0, muted: false, solo: false, output: 'a', effects: [], sends: [] }])).toEqual(['a', 'b', 'a']);
  });
  it('invalid JSON / limits', () => {
    const r1 = deserializeProject(new TextEncoder().encode('{"format":'));
    expect(!r1.ok && r1.errors[0].code).toBe('INVALID_JSON');
    let deep: unknown = 1; for (let i = 0; i < 40; i++) deep = [deep];
    const r2 = deserializeProject(new TextEncoder().encode(JSON.stringify({ a: deep })));
    expect(!r2.ok && r2.errors[0].code).toBe('INVALID_LIMIT');
  });
});

describe('S06 future version / failing migration', () => {
  it('future schemaVersion is refused read-only and input bytes untouched', () => {
    const p = { ...f00(), schemaVersion: 2 };
    const bytes = new TextEncoder().encode(JSON.stringify(p));
    const copy = bytes.slice();
    const r = deserializeProject(bytes);
    expect(!r.ok && r.errors[0].code).toBe('FUTURE_VERSION');
    expect(bytes).toEqual(copy);
  });
  it('failing migration returns error and leaves input unchanged', () => {
    const input = deepFreeze({ ...f00(), schemaVersion: 0 });
    const r = migrate(input, { 0: () => ({ ok: false, errors: [{ code: 'MIGRATION_FAILED', path: '$', message: 'boom' }] }) });
    expect(r.ok).toBe(false);
    expect(input.schemaVersion).toBe(0);
    const r2 = migrate(input, {});
    expect(!r2.ok && r2.errors[0].code).toBe('MIGRATION_FAILED');
  });
});
