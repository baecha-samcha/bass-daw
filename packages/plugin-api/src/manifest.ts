// 03 §2 manifest 검증. 알 수 없는 필드는 거절한다.
import type { PluginManifest, ParameterDescriptor, Result } from '@bass-daw/schemas';
import { PARAM_ID_RE, PLUGIN_ID_RE, SHA256_RE } from '@bass-daw/schemas';

export const MANIFEST_LIMITS = { maxMemoryPages: 1024, maxStateBytes: 1024 * 1024, maxBlockFrames: 4096, maxLatencyFrames: 96000, maxTailFrames: 480000, maxParameters: 256 };
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const KEYS: (keyof PluginManifest)[] = ['apiVersion', 'pluginId', 'version', 'role', 'name', 'vendor', 'dsp', 'ui', 'channels', 'parameters', 'articulations', 'voiceExpressions', 'stateVersion', 'maxStateBytes', 'maxMemoryPages', 'maxBlockFrames', 'latencyFrames', 'tailFrames', 'permissions', 'license'];

export function validateDescriptor(d: unknown, path: string, errs: string[]): void {
  const x = d as ParameterDescriptor;
  if (!x || typeof x !== 'object') return void errs.push(`${path}: object expected`);
  const allowed = ['id', 'name', 'unit', 'min', 'max', 'default', 'scale', 'steps', 'automation', 'smoothingMs'];
  for (const k of Object.keys(x)) if (!allowed.includes(k)) errs.push(`${path}.${k}: unknown field`);
  if (typeof x.id !== 'string' || !PARAM_ID_RE.test(x.id)) errs.push(`${path}.id: invalid parameter id`);
  if (typeof x.name !== 'string' || typeof x.unit !== 'string') errs.push(`${path}: name/unit string`);
  for (const k of ['min', 'max', 'default', 'smoothingMs'] as const) if (typeof x[k] !== 'number' || !Number.isFinite(x[k])) errs.push(`${path}.${k}: finite number`);
  if (!(x.min < x.max)) errs.push(`${path}: min < max required`);
  if (!(x.default >= x.min && x.default <= x.max)) errs.push(`${path}.default: out of range`);
  if (x.scale !== 'linear' && x.scale !== 'log') errs.push(`${path}.scale`);
  if (x.scale === 'log' && !(x.min > 0)) errs.push(`${path}: log scale requires min > 0`);
  if (!(x.steps === null || (Number.isInteger(x.steps) && x.steps >= 2))) errs.push(`${path}.steps: null or ≥2`);
  if (!['sample', 'block', 'none'].includes(x.automation)) errs.push(`${path}.automation`);
  if (!(x.smoothingMs >= 0 && x.smoothingMs <= 1000)) errs.push(`${path}.smoothingMs`);
}

export function validateManifest(input: unknown): Result<PluginManifest> {
  const errs: string[] = [];
  const m = input as PluginManifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return fail(['manifest: object expected']);
  for (const k of Object.keys(m)) if (!(KEYS as string[]).includes(k)) errs.push(`${k}: unknown field`);
  for (const k of KEYS) if (!(k in m)) errs.push(`${k}: missing`);
  if (m.apiVersion !== '1.0') errs.push(`apiVersion: unsupported ${m.apiVersion}`);
  if (typeof m.pluginId !== 'string' || !PLUGIN_ID_RE.test(m.pluginId) || m.pluginId.startsWith('builtin.')) errs.push('pluginId: reverse-DNS required (builtin.* reserved)');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) errs.push('version: semver required');
  if (m.role !== 'instrument' && m.role !== 'effect') errs.push('role');
  if (typeof m.name !== 'string' || !m.name || m.name.length > 128) errs.push('name');
  if (typeof m.vendor !== 'string' || m.vendor.length > 128) errs.push('vendor');
  if (!m.dsp || m.dsp.abi !== 'bass-daw-wasm-1') errs.push('dsp.abi: bass-daw-wasm-1 required');
  if (!m.dsp || typeof m.dsp.sha256 !== 'string' || !SHA256_RE.test(m.dsp.sha256)) errs.push('dsp.sha256');
  if (!m.dsp || typeof m.dsp.path !== 'string' || !/^[a-z0-9_-]+\.wasm$/.test(m.dsp.path)) errs.push('dsp.path');
  if (m.ui !== null && (typeof m.ui !== 'object' || !SHA256_RE.test(m.ui?.sha256 ?? '') || !/^[a-z0-9_-]+\.html$/.test(m.ui?.path ?? ''))) errs.push('ui: null or {path *.html, sha256}');
  const ch = m.channels;
  if (!ch || ![0, 1, 2].includes(ch.inputs) || ![1, 2].includes(ch.outputs)) errs.push('channels');
  if (m.role === 'instrument' && ch?.inputs !== 0) errs.push('channels.inputs: instrument must have 0 inputs');
  if (m.role === 'effect' && ch?.inputs === 0) errs.push('channels.inputs: effect needs inputs');
  if (!Array.isArray(m.parameters) || m.parameters.length > MANIFEST_LIMITS.maxParameters) errs.push('parameters');
  else { m.parameters.forEach((d, i) => validateDescriptor(d, `parameters[${i}]`, errs)); if (new Set(m.parameters.map((d) => d.id)).size !== m.parameters.length) errs.push('parameters: duplicate id'); }
  if (!Array.isArray(m.articulations) || m.articulations[0] !== 'normal' || m.articulations.some((a) => typeof a !== 'string')) errs.push("articulations: first must be 'normal'");
  if (!Array.isArray(m.voiceExpressions)) errs.push('voiceExpressions');
  else m.voiceExpressions.forEach((d, i) => validateDescriptor(d, `voiceExpressions[${i}]`, errs));
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(m.stateVersion, 0, 1e6)) errs.push('stateVersion');
  if (!int(m.maxStateBytes, 0, MANIFEST_LIMITS.maxStateBytes)) errs.push('maxStateBytes: ≤ 1MiB');
  if (!int(m.maxMemoryPages, 1, MANIFEST_LIMITS.maxMemoryPages)) errs.push('maxMemoryPages: 1..1024 (64MiB)');
  if (!int(m.maxBlockFrames, 64, MANIFEST_LIMITS.maxBlockFrames)) errs.push('maxBlockFrames: 64..4096');
  if (!int(m.latencyFrames, 0, MANIFEST_LIMITS.maxLatencyFrames)) errs.push('latencyFrames');
  if (!(m.tailFrames === null || int(m.tailFrames, 0, MANIFEST_LIMITS.maxTailFrames))) errs.push('tailFrames');
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => p !== 'read-selected-assets')) errs.push('permissions: only read-selected-assets');
  if (typeof m.license !== 'string' || !m.license) errs.push('license');
  return errs.length ? fail(errs) : { ok: true, value: m };
}

function fail<T>(errs: string[]): Result<T> {
  return { ok: false, errors: errs.map((e) => ({ code: 'MANIFEST_INVALID', path: `$.${e.split(':')[0]}`, message: e })) };
}

export const pluginKey = (pluginId: string, version: string) => `${pluginId}@${version}`;
