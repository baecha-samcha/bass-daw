import { describe, it, expect } from 'vitest';
import { ProjectSession, applyCommand, findClip, UNDO_LIMIT } from '@bass-daw/project-core';
import { snapshotHash, validateProject, canonicalStringify } from '@bass-daw/schemas';
import type { Project, AudioClip, MusicClip } from '@bass-daw/schemas';
import { f00, f03, deepFreeze, FIXED_NOW } from '../../../tests/fixtures/projects.ts';
import { fid } from '../../../tests/fixtures/ids.ts';

const session = (p: Project) => { const s = new ProjectSession(deepFreeze(p)); s.clock = () => FIXED_NOW; return s; };
const sourceHash = async (p: Project, id: string) => snapshotHash(p.sources.find((s) => s.id === id));

describe('S04 split → Undo', () => {
  it('music split keeps source hash and undo restores exactly', async () => {
    const s = session(f03());
    const before = await snapshotHash(s.project);
    const srcBefore = await sourceHash(s.project, fid(50));
    const r = s.run('split', { type: 'SplitClip', clipId: fid(91), tick: 1000 });
    expect(r.ok).toBe(true);
    const clips = s.project.tracks[0].clips as MusicClip[];
    expect(clips.map((c) => [c.startTick, c.durationTicks, c.sourceOffsetTick])).toEqual([[0, 1000, 0], [1000, 2840, 1000], [3840, 1920, 480]]);
    expect(await sourceHash(s.project, fid(50))).toBe(srcBefore);
    s.undo();
    expect(await snapshotHash(s.project)).toBe(before);
    s.redo();
    expect((s.project.tracks[0].clips as MusicClip[]).length).toBe(3);
  });
  it('loop clip split offset wraps modulo source length', () => {
    const s = session(f03());
    s.run('split', { type: 'SplitClip', clipId: fid(96), tick: 1440 });
    const c = s.project.tracks[2].clips as MusicClip[];
    expect(c.map((x) => [x.startTick, x.durationTicks, x.sourceOffsetTick])).toEqual([[0, 1440, 960], [1440, 6240, (960 + 1440) % 1920]]);
  });
  it('audio split: frame sum equals original selection, original asset untouched', async () => {
    const s = session(f03());
    const orig = findClip(s.project, fid(98))!.clip as AudioClip;
    const assetHash = await snapshotHash(s.project.assets);
    // 1.5s + 12345/48000 s
    s.run('split', { type: 'SplitClip', clipId: fid(98), seconds: 1.5 + 12345 / 48000 });
    const [a, b] = s.project.tracks[3].clips as AudioClip[];
    expect(a.sourceFrameCount + b.sourceFrameCount).toBe(orig.sourceFrameCount);
    expect(a.sourceFrameCount).toBe(12345);
    expect(b.sourceStartFrame).toBe(orig.sourceStartFrame + 12345);
    expect(a.sourceStartFrame).toBe(orig.sourceStartFrame);
    expect(b.fadeOutFrames).toBe(orig.fadeOutFrames);
    expect(await snapshotHash(s.project.assets)).toBe(assetHash);
    s.undo();
    expect(s.project.tracks[3].clips).toEqual([orig]);
  });
  it('split outside clip is rejected and state unchanged', async () => {
    const s = session(f03());
    const h = await snapshotHash(s.project);
    expect(s.run('split', { type: 'SplitClip', clipId: fid(91), tick: 0 }).ok).toBe(false);
    expect(s.run('split', { type: 'SplitClip', clipId: fid(91), tick: 3840 }).ok).toBe(false);
    expect(await snapshotHash(s.project)).toBe(h);
    expect(s.editSequence).toBe(0);
  });
});

describe('commands & undo', () => {
  it('create four instrument tracks, rename, tempo, undo/redo', () => {
    const s = session(f00());
    for (const [kind, instrument] of [['tab', 'bass'], ['tab', 'guitar'], ['midi'], ['drum']] as const) {
      expect(s.run('add', { type: 'CreateTrack', kind, instrument, withClip: true }).ok).toBe(true);
    }
    expect(s.project.tracks.map((t) => t.name)).toEqual(['Bass', 'Guitar', 'Keys', 'Drums']);
    expect(s.project.channels.length).toBe(5);
    const id = s.project.tracks[0].id;
    s.run('rename', { type: 'RenameTrack', trackId: id, name: 'Fretless' });
    s.run('tempo', { type: 'SetTempoMap', tempoMap: [{ tick: 0, bpm: 98, transition: 'step' }] });
    expect(s.project.tempoMap[0].bpm).toBe(98);
    s.undo(); s.undo();
    expect(s.project.tracks[0].name).toBe('Bass');
    expect(s.project.tempoMap[0].bpm).toBe(120);
    s.redo();
    expect(s.project.tracks[0].name).toBe('Fretless');
    // 새 편집은 redo 분기를 해제
    s.run('title', { type: 'SetTitle', title: 'X' });
    expect(s.canRedo).toBe(false);
    expect(validateProject(s.project).ok).toBe(true);
  });
  it('STALE_EDIT rejected', () => {
    const s = session(f00());
    s.run('t', { type: 'SetTitle', title: 'a' });
    const r = s.execute({ id: 'x', expectedEditSequence: 0, label: 'stale', changes: { type: 'SetTitle', title: 'b' } });
    expect(!r.ok && r.errors[0].code).toBe('STALE_EDIT');
    expect(s.project.title).toBe('a');
  });
  it('batch is atomic', async () => {
    const s = session(f03());
    const h = await snapshotHash(s.project);
    const r = s.run('batch', { type: 'Batch', commands: [{ type: 'SetTitle', title: 'changed' }, { type: 'MoveClip', clipId: 'nope', startTick: 0 }] });
    expect(r.ok).toBe(false);
    expect(await snapshotHash(s.project)).toBe(h);
  });
  it('invalid result (validation) leaves state unchanged', () => {
    const s = session(f03());
    const r = s.run('bad', { type: 'SetParameter', owner: 'channel', ownerId: fid(10), parameterId: 'gain', value: 9 });
    expect(r.ok).toBe(false);
    expect(s.project.channels.find((c) => c.id === fid(10))!.gain).toBe(1);
  });
  it('feedback route rejected', () => {
    const s = session(f03());
    s.run('bus', { type: 'CreateBus', name: 'B', busId: 'bus-b' });
    expect(s.run('route', { type: 'SetRouting', channelId: fid(14), output: 'bus-b' }).ok).toBe(true);
    const r = s.run('route', { type: 'SetRouting', channelId: 'bus-b', sends: [{ id: 'sx', targetChannelId: fid(14), gain: 1, tap: 'post' }] });
    expect(!r.ok && r.errors.some((e) => e.code === 'INVALID_ROUTING')).toBe(true);
  });
  it('undo limit 100 commands', () => {
    const s = session(f00());
    for (let i = 0; i < UNDO_LIMIT.commands + 20; i++) s.run('t', { type: 'SetTitle', title: `t${i}` });
    expect(s.undoDepth).toBe(100);
    expect(s.undoTrimmed).toBe(20);
  });
});

describe('copy-on-write', () => {
  it('editing a clip that shares a source clones it; other clip unchanged', async () => {
    const s = session(f03());
    const shared = await sourceHash(s.project, fid(50));
    const r = s.run('edit', { type: 'EditNotes', clipId: fid(92), ops: [{ op: 'update', collection: 'notes', id: fid(54), patch: { velocity: 10 } }] });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.diagnostics[0]).toMatch(/COPY_ON_WRITE/);
    const c91 = findClip(s.project, fid(91))!.clip, c92 = findClip(s.project, fid(92))!.clip;
    expect(c91.sourceId).toBe(fid(50));
    expect(c92.sourceId).not.toBe(fid(50));
    expect(await sourceHash(s.project, fid(50))).toBe(shared);
    const cloned = s.project.sources.find((x) => x.id === c92.sourceId)!;
    if (cloned.kind !== 'tab') throw new Error();
    // ID 재발급, 링크 재매핑, 이벤트 값 동일
    expect(cloned.notes.every((n) => !n.id.startsWith('00000000'))).toBe(true);
    const first = cloned.notes[0];
    const tgt = (first.techniques[0] as { targetNoteId: string }).targetNoteId;
    expect(cloned.notes.some((n) => n.id === tgt)).toBe(true);
    expect(cloned.notes.find((n) => n.stringIndex === 1)!.velocity).toBe(10);
    s.undo();
    expect(findClip(s.project, fid(92))!.clip.sourceId).toBe(fid(50));
  });
  it('trim music clip start adjusts offset; trim audio keeps frames consistent', () => {
    const s = session(f03());
    expect(s.run('trim', { type: 'TrimClip', clipId: fid(92), edge: 'start', tick: 3840 + 240 }).ok).toBe(true);
    const c = findClip(s.project, fid(92))!.clip as MusicClip;
    expect([c.startTick, c.durationTicks, c.sourceOffsetTick]).toEqual([4080, 1680, 720]);
    expect(s.run('trim', { type: 'TrimClip', clipId: fid(98), edge: 'start', seconds: 1.5 + 0.01 }).ok).toBe(true);
    const a = findClip(s.project, fid(98))!.clip as AudioClip;
    expect(a.sourceStartFrame).toBe(1000 + 480);
    expect(a.sourceFrameCount).toBe(40000 - 480);
    expect(a.startSeconds).toBeCloseTo(1.51, 12);
  });
});

describe('performance (recorded, 05 §2 small command p95 16ms target)', () => {
  it('note edit on 16-track 10k-note project', () => {
    const s = session(f00());
    for (let t = 0; t < 16; t++) s.run('t', { type: 'CreateTrack', kind: 'midi', withClip: true, lengthTicks: 960 * 4 * 64 });
    const clipId = s.project.tracks[0].clips[0].id;
    for (let t = 0; t < 16; t++) {
      const cid = s.project.tracks[t].clips[0].id;
      const ops = Array.from({ length: 625 }, (_, i) => ({ op: 'add' as const, collection: 'notes' as const, item: { id: `n-${t}-${i}`, tick: i * 384, durationTicks: 192, pitch: 40 + (i % 40), velocity: 90, channel: 0 } }));
      expect(s.run('bulk', { type: 'EditNotes', clipId: cid, ops }).ok).toBe(true);
    }
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      s.run('edit', { type: 'EditNotes', clipId, ops: [{ op: 'update', collection: 'notes', id: 'n-0-5', patch: { velocity: 1 + (i % 120) } }] });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[94];
    console.log(`[perf] small command p95=${p95.toFixed(2)}ms p50=${times[49].toFixed(2)}ms (10,000 notes, node)`);
    expect(canonicalStringify(s.project).length).toBeGreaterThan(100_000);
  });
});
