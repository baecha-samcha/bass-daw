// 빈 프로젝트(F00)와 기본 객체 생성기. ID 는 UUID v4.
import type { Project, Channel, PluginInstance, Track, TrackKind, Source } from './types.ts';
import { defaultParameters, BUILTIN_VERSION, BUILTIN_DESCRIPTORS } from './plugin-contracts.ts';

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso(d = new Date()): string {
  return d.toISOString();
}

export function createEmptyProject(opts: { id?: string; title?: string; now?: string; masterId?: string } = {}): Project {
  const now = opts.now ?? nowIso();
  const masterId = opts.masterId ?? uuid();
  return {
    format: 'bass-daw-project', schemaVersion: 1, id: opts.id ?? uuid(),
    title: opts.title ?? 'Untitled', createdAt: now, updatedAt: now, ppq: 960,
    tempoMap: [{ tick: 0, bpm: 120, transition: 'step' }],
    meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
    tracks: [], sources: [], assets: [],
    channels: [{ id: masterId, kind: 'master', name: 'Master', gain: 1, pan: 0, muted: false, solo: false, output: null, effects: [], sends: [] }],
    masterChannelId: masterId,
    plugins: [], automation: [],
    loop: { enabled: false, startTick: 0, endTick: 960 * 4 * 4 },
    metadata: {},
  };
}

export function createChannel(kind: 'track' | 'bus', name: string, output: string): Channel {
  return { id: uuid(), kind, name, gain: 1, pan: 0, muted: false, solo: false, output, effects: [], sends: [] };
}

export function createPlugin(pluginId: string, state: PluginInstance['state'] = null): PluginInstance {
  const d = BUILTIN_DESCRIPTORS[pluginId];
  return {
    instanceId: uuid(), pluginId, pluginVersion: BUILTIN_VERSION, stateVersion: d?.stateVersion ?? 1,
    role: d?.role ?? 'effect', state, parameters: defaultParameters(pluginId), assets: [],
  };
}

export const TRACK_COLORS = ['#e07a5f', '#3d9970', '#4f86c6', '#c9a227', '#9b5de5', '#f15bb5', '#00bbf9', '#7cb518'];

export const STANDARD_TUNINGS = {
  bass4: [28, 33, 38, 43],          // E1 A1 D2 G2
  bass5: [23, 28, 33, 38, 43],      // B0 E1 A1 D2 G2
  guitar6: [40, 45, 50, 55, 59, 64], // E2 A2 D3 G3 B3 E4
  guitar7: [35, 40, 45, 50, 55, 59, 64],
} as const;

export const GM_DRUM_PADS = [
  { name: 'Kick', midiPitch: 36, chokeGroup: null },
  { name: 'Snare', midiPitch: 38, chokeGroup: null },
  { name: 'Closed HH', midiPitch: 42, chokeGroup: 1 },
  { name: 'Open HH', midiPitch: 46, chokeGroup: 1 },
  { name: 'Low Tom', midiPitch: 45, chokeGroup: null },
  { name: 'Hi Tom', midiPitch: 50, chokeGroup: null },
  { name: 'Crash', midiPitch: 49, chokeGroup: null },
  { name: 'Ride', midiPitch: 51, chokeGroup: null },
] as const;

export function createSourceFor(kind: TrackKind, opts: { instrument?: 'bass' | 'guitar'; lengthTicks?: number; assetId?: string } = {}): Source {
  const lengthTicks = opts.lengthTicks ?? 960 * 4 * 8;
  switch (kind) {
    case 'tab': {
      const instrument = opts.instrument ?? 'bass';
      return { id: uuid(), kind: 'tab', lengthTicks, instrument, tuning: [...(instrument === 'bass' ? STANDARD_TUNINGS.bass4 : STANDARD_TUNINGS.guitar6)], maxFret: 24, notes: [], strums: [] };
    }
    case 'midi': return { id: uuid(), kind: 'midi', lengthTicks, notes: [], cc: [], pitchBend: [] };
    case 'drum': return { id: uuid(), kind: 'drum', lengthTicks, hits: [], pads: GM_DRUM_PADS.map((p) => ({ id: uuid(), ...p })) };
    case 'audio': return { id: uuid(), kind: 'audio', assetId: opts.assetId ?? '' };
  }
}

export function nextTrackOrder(tracks: Track[]): number {
  return tracks.reduce((m, t) => Math.max(m, t.order + 1), 0);
}
