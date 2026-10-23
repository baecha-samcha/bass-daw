// F00 / F03 fixture 빌더 (05 §3). 모든 ID·날짜 고정.
import type { Project } from '@bass-daw/schemas';
import { createEmptyProject } from '@bass-daw/schemas';
import { fid } from './ids.ts';

export const FIXED_NOW = '2026-10-22T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

export function f00(): Project {
  return createEmptyProject({ id: fid(1), title: 'F00', now: FIXED_NOW, masterId: fid(2) });
}

/** F03: 동일 source 공유·루프·트림·동음이현·주법·CC/sustain·pitchbend·미설치 plugin state 포함 */
export function f03(): Project {
  const p = f00();
  p.title = 'F03';
  const M = fid(2);
  p.channels.push(
    { id: fid(10), kind: 'track', name: 'Bass', gain: 1, pan: 0, muted: false, solo: false, output: fid(14), effects: [fid(33)], sends: [{ id: fid(15), targetChannelId: fid(14), gain: 0.5, tap: 'pre' }] },
    { id: fid(11), kind: 'track', name: 'Keys', gain: 0.8, pan: -0.5, muted: false, solo: false, output: M, effects: [], sends: [] },
    { id: fid(12), kind: 'track', name: 'Drums', gain: 1, pan: 0, muted: false, solo: false, output: M, effects: [], sends: [] },
    { id: fid(13), kind: 'track', name: 'Vox', gain: 1, pan: 0.25, muted: false, solo: false, output: M, effects: [], sends: [] },
    { id: fid(14), kind: 'bus', name: 'Bus A', gain: 1, pan: 0, muted: false, solo: false, output: M, effects: [], sends: [] },
  );
  p.plugins.push(
    { instanceId: fid(30), pluginId: 'builtin.sampler', pluginVersion: '1.0.0', stateVersion: 1, role: 'instrument', state: { version: 1, zones: [], pads: [], attackMs: 5, releaseMs: 80 }, parameters: { gain: 1, attackMs: 5, releaseMs: 80 }, assets: [] },
    { instanceId: fid(31), pluginId: 'builtin.sampler', pluginVersion: '1.0.0', stateVersion: 1, role: 'instrument', state: { version: 1, zones: [], pads: [], attackMs: 5, releaseMs: 80 }, parameters: { gain: 1 }, assets: [] },
    // 미설치 서드파티 instrument — 상태와 파라미터를 그대로 보존해야 한다(S03)
    { instanceId: fid(32), pluginId: 'com.example.unknown-drums', pluginVersion: '3.1.4', stateVersion: 7, role: 'instrument', state: { kit: 'vintage', nested: { a: [1, 2, { b: null }] }, future: true }, parameters: { 'tone.color': 0.25 }, assets: [] },
    { instanceId: fid(33), pluginId: 'builtin.eq', pluginVersion: '1.0.0', stateVersion: 1, role: 'effect', state: { version: 1 }, parameters: { 'band1.gainDb': 3 }, assets: [] },
  );
  p.assets.push(
    { id: fid(40), sha256: SHA_A, byteLength: 96044, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: 48000 }, license: { name: 'self-recorded', origin: 'user', redistribution: 'allowed' } },
    { id: fid(41), sha256: SHA_B, byteLength: 10, mediaType: 'audio/wav', audio: null, license: { name: 'unknown', origin: 'import', redistribution: 'unknown' } },
  );
  p.sources.push(
    {
      id: fid(50), kind: 'tab', lengthTicks: 3840, instrument: 'bass', tuning: [28, 33, 38, 43], maxFret: 24,
      notes: [
        // 동음이현: string0 fret5 (A1=33) 와 string1 fret0 (A1=33)
        { id: fid(51), tick: 0, durationTicks: 480, stringIndex: 0, fret: 5, velocity: 100, techniques: [{ kind: 'hammer-on', targetNoteId: fid(52) }] },
        { id: fid(52), tick: 480, durationTicks: 480, stringIndex: 0, fret: 7, velocity: 90, techniques: [{ kind: 'slide', targetNoteId: fid(53) }] },
        { id: fid(53), tick: 960, durationTicks: 960, stringIndex: 0, fret: 3, velocity: 90, techniques: [{ kind: 'bend', points: [{ offsetTick: 0, semitones: 0 }, { offsetTick: 480, semitones: 1 }, { offsetTick: 960, semitones: 0.5 }] }] },
        { id: fid(54), tick: 0, durationTicks: 960, stringIndex: 1, fret: 0, velocity: 80, techniques: [{ kind: 'slap' }] },
        { id: fid(55), tick: 1920, durationTicks: 240, stringIndex: 2, fret: 2, velocity: 70, techniques: [{ kind: 'mute' }, { kind: 'pop' }] },
      ],
      strums: [],
    },
    {
      id: fid(60), kind: 'midi', lengthTicks: 3840,
      notes: [
        { id: fid(61), tick: 0, durationTicks: 960, pitch: 60, velocity: 100, channel: 0 },
        { id: fid(62), tick: 0, durationTicks: 960, pitch: 64, velocity: 90, channel: 1 },
        { id: fid(63), tick: 3000, durationTicks: 840, pitch: 67, velocity: 1, channel: 15 },
      ],
      cc: [{ id: fid(64), tick: 0, channel: 0, controller: 64, value: 127 }, { id: fid(65), tick: 1920, channel: 0, controller: 64, value: 0 }],
      pitchBend: [{ id: fid(66), tick: 100, channel: 0, value: -8192 }, { id: fid(67), tick: 200, channel: 0, value: 8191 }],
    },
    {
      id: fid(70), kind: 'drum', lengthTicks: 1920,
      pads: [{ id: fid(71), name: 'Kick', midiPitch: 36, chokeGroup: null }, { id: fid(72), name: 'CHH', midiPitch: 42, chokeGroup: 1 }, { id: fid(73), name: 'OHH', midiPitch: 46, chokeGroup: 1 }],
      hits: [{ id: fid(74), tick: 0, padId: fid(71), velocity: 120 }, { id: fid(75), tick: 480, padId: fid(73), velocity: 90 }, { id: fid(76), tick: 720, padId: fid(72), velocity: 80 }],
    },
    { id: fid(80), kind: 'audio', assetId: fid(40) },
  );
  p.tracks.push(
    { id: fid(90), name: 'Bass', color: '#e07a5f', order: 0, kind: 'tab', channelId: fid(10), muted: false, solo: false, instrumentSlot: fid(30), clips: [
      { id: fid(91), kind: 'music', sourceId: fid(50), name: 'A', muted: false, startTick: 0, durationTicks: 3840, sourceOffsetTick: 0, loopSource: false },
      // 같은 source 공유 + trim
      { id: fid(92), kind: 'music', sourceId: fid(50), name: 'A2', muted: false, startTick: 3840, durationTicks: 1920, sourceOffsetTick: 480, loopSource: false },
    ] },
    { id: fid(93), name: 'Keys', color: '#4f86c6', order: 1, kind: 'midi', channelId: fid(11), muted: false, solo: false, instrumentSlot: fid(31), clips: [
      { id: fid(94), kind: 'music', sourceId: fid(60), name: 'K', muted: false, startTick: 0, durationTicks: 3840, sourceOffsetTick: 0, loopSource: false },
    ] },
    { id: fid(95), name: 'Drums', color: '#c9a227', order: 2, kind: 'drum', channelId: fid(12), muted: false, solo: false, instrumentSlot: fid(32), clips: [
      // 루프 클립: offset 960 에서 시작해 source 1920 로 wrap
      { id: fid(96), kind: 'music', sourceId: fid(70), name: 'Loop', muted: false, startTick: 0, durationTicks: 7680, sourceOffsetTick: 960, loopSource: true },
    ] },
    { id: fid(97), name: 'Vox', color: '#9b5de5', order: 3, kind: 'audio', channelId: fid(13), muted: false, solo: false, instrumentSlot: null, clips: [
      { id: fid(98), kind: 'audio', sourceId: fid(80), name: 'take1', muted: false, startSeconds: 1.5, sourceStartFrame: 1000, sourceFrameCount: 40000, gain: 0.9, fadeInFrames: 480, fadeOutFrames: 960 },
    ] },
  );
  p.automation.push(
    { id: fid(100), target: { owner: 'channel', ownerId: fid(10), parameterId: 'gain' }, enabled: true, points: [{ tick: 0, value: 0, interpolation: 'linear' }, { tick: 1920, value: 1, interpolation: 'step' }, { tick: 3840, value: 0.5, interpolation: 'linear' }] },
    { id: fid(101), target: { owner: 'plugin', ownerId: fid(32), parameterId: 'tone.color' }, enabled: false, points: [{ tick: 0, value: 0.1, interpolation: 'step' }] },
  );
  p.metadata = { composer: 'fixture', 'ünïcode': '한글 ✓' };
  return p;
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
