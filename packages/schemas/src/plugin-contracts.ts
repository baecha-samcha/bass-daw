// 03-plugin-api.md §2 의 descriptor 계약. 검증기(02 자동화 범위)와 엔진이 함께 쓰므로 schemas 에 둔다.
// (docs/decisions/0002-plugin-contracts-location.md)
import type { Id } from './types.ts';

export interface ParameterDescriptor {
  id: string; name: string; unit: string;
  min: number; max: number; default: number;
  scale: 'linear' | 'log'; steps: number | null;
  automation: 'sample' | 'block' | 'none'; smoothingMs: number;
}

export interface PluginManifest {
  apiVersion: '1.0'; pluginId: string; version: string;
  role: 'instrument' | 'effect'; name: string; vendor: string;
  dsp: { abi: 'bass-daw-wasm-1'; sha256: string; path: string };
  ui: null | { path: string; sha256: string };
  channels: { inputs: 0 | 1 | 2; outputs: 1 | 2 };
  parameters: ParameterDescriptor[];
  articulations: string[];
  voiceExpressions: ParameterDescriptor[];
  stateVersion: number; maxStateBytes: number;
  maxMemoryPages: number; maxBlockFrames: number;
  latencyFrames: number; tailFrames: number | null;
  permissions: ('read-selected-assets')[];
  license: string;
}

export interface SamplerZone {
  id: Id; assetId: Id; rootPitch: number;
  minPitch: number; maxPitch: number; minVelocity: number; maxVelocity: number;
  articulation: string; loopStartFrame: number | null; loopEndFrame: number | null;
}
export interface SamplerPad { padId: Id; assetId: Id; gain: number; chokeGroup: number | null }
export interface BuiltinSamplerState {
  version: 1;
  zones: SamplerZone[];
  pads: SamplerPad[];
  attackMs: number; releaseMs: number;
}
export interface BuiltinReverbState { version: 1; irAssetId: Id | null }

// 03 §2 의 정규식은 소문자만 허용하지만 같은 문서의 내장 ID(attackMs, gainDb…)는 camelCase 이다.
// 최소 수정: 첫 글자 이후 ASCII 대문자 허용 (docs/decisions/0001-parameter-id-case.md)
export const PARAM_ID_RE = /^[a-z][a-zA-Z0-9._-]{0,63}$/;
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

const p = (id: string, name: string, unit: string, min: number, max: number, def: number,
  extra: Partial<ParameterDescriptor> = {}): ParameterDescriptor => ({
  id, name, unit, min, max, default: def, scale: 'linear', steps: null,
  automation: 'sample', smoothingMs: 5, ...extra,
});

export const BUILTIN_VERSION = '1.0.0';
export const BUILTIN_DESCRIPTORS: Record<string, { role: 'instrument' | 'effect'; parameters: ParameterDescriptor[]; articulations: string[]; voiceExpressions: ParameterDescriptor[]; stateVersion: number }> = {
  'builtin.sampler': {
    role: 'instrument', stateVersion: 1,
    parameters: [
      p('gain', 'Gain', 'linear', 0, 4, 1),
      p('attackMs', 'Attack', 'ms', 0, 500, 5, { automation: 'block', smoothingMs: 0 }),
      p('releaseMs', 'Release', 'ms', 1, 5000, 80, { automation: 'block', smoothingMs: 0 }),
    ],
    articulations: ['normal', 'mute', 'slap', 'pop'],
    voiceExpressions: [p('pitch.semitones', 'Bend', 'st', -12, 12, 0, { smoothingMs: 0 })],
  },
  'builtin.eq': {
    role: 'effect', stateVersion: 1,
    parameters: [1, 2, 3].flatMap((b, i) => [
      p(`band${b}.frequencyHz`, `Band ${b} Freq`, 'Hz', 20, 20000, [100, 1000, 8000][i], { scale: 'log', automation: 'block', smoothingMs: 0 }),
      p(`band${b}.gainDb`, `Band ${b} Gain`, 'dB', -24, 24, 0, { automation: 'block', smoothingMs: 0 }),
      p(`band${b}.q`, `Band ${b} Q`, '', 0.1, 18, 0.707, { scale: 'log', automation: 'block', smoothingMs: 0 }),
    ]),
    articulations: ['normal'], voiceExpressions: [],
  },
  'builtin.compressor': {
    role: 'effect', stateVersion: 1,
    parameters: [
      p('thresholdDb', 'Threshold', 'dB', -60, 0, -18, { automation: 'block', smoothingMs: 0 }),
      p('ratio', 'Ratio', ':1', 1, 20, 4, { automation: 'block', smoothingMs: 0 }),
      p('attackMs', 'Attack', 'ms', 0.1, 100, 10, { scale: 'log', automation: 'block', smoothingMs: 0 }),
      p('releaseMs', 'Release', 'ms', 10, 2000, 100, { scale: 'log', automation: 'block', smoothingMs: 0 }),
      p('makeupDb', 'Makeup', 'dB', 0, 24, 0, { automation: 'block', smoothingMs: 0 }),
      p('lookaheadMs', 'Lookahead', 'ms', 0, 20, 0, { automation: 'none', smoothingMs: 0 }),
    ],
    articulations: ['normal'], voiceExpressions: [],
  },
  'builtin.reverb': {
    role: 'effect', stateVersion: 1,
    parameters: [
      p('wet', 'Wet', '', 0, 1, 0.2),
      p('dry', 'Dry', '', 0, 1, 1),
      p('predelayMs', 'Predelay', 'ms', 0, 200, 0, { automation: 'none', smoothingMs: 0 }),
    ],
    articulations: ['normal'], voiceExpressions: [],
  },
};

export const CHANNEL_PARAMETERS: ParameterDescriptor[] = [
  p('gain', 'Gain', 'linear', 0, 4, 1),
  p('pan', 'Pan', '', -1, 1, 0),
];

export function findDescriptor(pluginId: string, parameterId: string): ParameterDescriptor | undefined {
  return BUILTIN_DESCRIPTORS[pluginId]?.parameters.find((d) => d.id === parameterId);
}

export function defaultParameters(pluginId: string): Record<string, number> {
  const d = BUILTIN_DESCRIPTORS[pluginId];
  const out: Record<string, number> = {};
  if (d) for (const x of d.parameters) out[x.id] = x.default;
  return out;
}
