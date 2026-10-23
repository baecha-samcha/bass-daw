// 엔진 테스트 fixture: latency=0 단일 impulse 악기, DC 악기, 프로그램적 프로젝트 빌더.
import type { Project, TempoPoint, Asset } from '@bass-daw/schemas';
import { sha256HexSync } from '@bass-daw/schemas';
import { ProjectSession } from '@bass-daw/project-core';
import { encodeWav, type Pcm } from '@bass-daw/audio-engine';
import { f00, FIXED_NOW } from './projects.ts';

export const SR = 48000;

export function pcmOf(data: Float32Array, sr = SR): Pcm { return { sampleRate: sr, channels: [data], frames: data.length }; }
export function impulse(len = 64): Float32Array { const x = new Float32Array(len); x[0] = 1; return x; }
export function dc(len: number, v = 0.5): Float32Array { return new Float32Array(len).fill(v); }

export class Builder {
  s: ProjectSession;
  pcm = new Map<string, Pcm>();
  constructor(tempo: TempoPoint[] = [{ tick: 0, bpm: 120, transition: 'step' }]) {
    this.s = new ProjectSession(f00());
    this.s.clock = () => FIXED_NOW;
    this.run({ type: 'SetTempoMap', tempoMap: tempo });
  }
  get p(): Project { return this.s.project; }
  run(c: Parameters<ProjectSession['run']>[1]) { const r = this.s.run('t', c); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.value; }
  asset(data: Float32Array, id: string, sr = SR): Asset {
    const p = pcmOf(data, sr);
    const bytes = encodeWav(p, 'wav-float32');
    const sha = sha256HexSync(bytes);
    this.pcm.set(sha, p);
    const a: Asset = { id, sha256: sha, byteLength: bytes.length, mediaType: 'audio/wav', audio: { sampleRate: sr, channels: 1, frameCount: data.length }, license: { name: 'test', origin: 'test', redistribution: 'allowed' } };
    this.run({ type: 'AddAsset', asset: a });
    return a;
  }
  /** MIDI 트랙 + 단일 zone sampler (root=pitch 전체 범위 → rate 1) */
  midiTrack(name: string, sample: Float32Array, notes: { tick: number; dur: number; pitch?: number; vel?: number; channel?: number }[], opts: { lengthTicks?: number; loop?: [number, number] | null; cc?: { tick: number; controller: number; value: number; channel?: number }[]; attackMs?: number; releaseMs?: number; root?: number } = {}) {
    const trackId = `trk-${name}`;
    this.run({ type: 'CreateTrack', kind: 'midi', name, trackId });
    const t = this.p.tracks.find((x) => x.id === trackId)!;
    const a = this.asset(sample, `asset-${name}`);
    const root = opts.root ?? 60;
    this.run({ type: 'SetPluginState', instanceId: t.instrumentSlot!, state: { version: 1, zones: [{ id: `z-${name}`, assetId: a.id, rootPitch: root, minPitch: 0, maxPitch: 127, minVelocity: 1, maxVelocity: 127, articulation: 'normal', loopStartFrame: opts.loop?.[0] ?? null, loopEndFrame: opts.loop?.[1] ?? null }], pads: [], attackMs: opts.attackMs ?? 0, releaseMs: opts.releaseMs ?? 1 }, assets: [a.id] });
    this.run({ type: 'SetParameter', owner: 'plugin', ownerId: t.instrumentSlot!, parameterId: 'attackMs', value: opts.attackMs ?? 0 });
    this.run({ type: 'SetParameter', owner: 'plugin', ownerId: t.instrumentSlot!, parameterId: 'releaseMs', value: opts.releaseMs ?? 1 });
    const len = opts.lengthTicks ?? 960 * 4 * 64;
    const src = { id: `src-${name}`, kind: 'midi' as const, lengthTicks: len, notes: notes.map((n, i) => ({ id: `n-${name}-${i}`, tick: n.tick, durationTicks: n.dur, pitch: n.pitch ?? root, velocity: n.vel ?? 127, channel: n.channel ?? 0 })), cc: (opts.cc ?? []).map((c, i) => ({ id: `cc-${name}-${i}`, tick: c.tick, channel: c.channel ?? 0, controller: c.controller, value: c.value })), pitchBend: [] };
    this.run({ type: 'CreateSource', source: src });
    this.run({ type: 'PlaceClip', trackId, clip: { id: `clip-${name}`, kind: 'music', sourceId: src.id, name, muted: false, startTick: 0, durationTicks: len, sourceOffsetTick: 0, loopSource: false } });
    return { trackId, channelId: t.channelId, instanceId: t.instrumentSlot! };
  }
}

/** 출력에서 임계값을 넘는 sample onset 위치(연속 구간의 시작) */
export function onsets(x: Float32Array, thr = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr && (i === 0 || Math.abs(x[i - 1]) <= thr)) out.push(i);
  return out;
}
