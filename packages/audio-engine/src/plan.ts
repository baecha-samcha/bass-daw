// 제어 스레드에서 Project → 렌더 계획(그래프 + frame 이벤트 표) 컴파일 (01 §2–3, §6).
// 결과는 직렬화 가능한 구조이며 Worklet 과 offline renderer 가 같은 RenderCore 로 소비한다.
import type { Project, Id, Source, MusicClip, AudioClip, Channel, Json, PluginManifest, PluginInstance } from '@bass-daw/schemas';
import { BUILTIN_DESCRIPTORS, CHANNEL_PARAMETERS, findDescriptor } from '@bass-daw/schemas';
import { TempoMap, expandClip, KIND_PRIORITY, type PerformanceEvent, type SourceCompileResult, type CompileDiagnostic } from '@bass-daw/music-core';
import { compileTabSource } from '@bass-daw/tab-engine';
import { compileMidiSource, compileDrumSource } from '@bass-daw/midi-engine';
import { REVERB_LATENCY } from './dsp/reverb.ts';

export type Profile = 'high' | 'balanced' | 'low';
export const POLYPHONY: Record<Profile, number> = { high: 128, balanced: 64, low: 32 };
export const PCM_BUDGET_BYTES: Record<Profile, number> = { high: 384 * 1024 * 1024, balanced: 192 * 1024 * 1024, low: 96 * 1024 * 1024 };

export const EV_NOTE_ON = 1, EV_NOTE_OFF = 2, EV_CC = 3, EV_PITCH_BEND = 4, EV_EXPRESSION = 5, EV_ALL_OFF = 6;
export const SLOT_LOCATE = 100, SLOT_WATERMARK = 101;

export interface AutomationPointRt { frame: number; value: number; linear: boolean }
export interface AutomationRt { points: AutomationPointRt[]; defaultValue: number }

export interface EffectRt {
  instanceId: Id; pluginId: string; paramIds: string[]; values: number[]; automation: (AutomationRt | null)[];
  lookaheadMs: number; predelayMs: number; irAssetHash: string | null; bypass: boolean;
  /** 설치·고정 hash 가 확인된 외부 WASM 플러그인 */
  wasm: WasmRef | null;
}
export interface WasmRef { key: string; manifest: PluginManifest; memoryPages: number; stateJson: string }
export interface PluginResolver { (pluginId: string, version: string): { key: string; manifest: PluginManifest; memoryPages: number } | null }
export interface ZoneDesc { id: string; assetHash: string | null; rootPitch: number; minPitch: number; maxPitch: number; minVelocity: number; maxVelocity: number; articulation: string; loopStartFrame: number | null; loopEndFrame: number | null }
export interface PadDesc { padId: string; assetHash: string | null; gain: number; chokeGroup: number | null }
export interface InstrumentRt {
  instanceId: Id; pluginId: string; supported: boolean; zones: ZoneDesc[]; pads: PadDesc[]; attackMs: number; releaseMs: number;
  gain: number; gainAutomation: AutomationRt | null;
  wasm: WasmRef | null; sampleHashes: (string | null)[];
  paramIds: string[]; values: number[]; automation: (AutomationRt | null)[];
}
export interface AudioClipRt { clipId: Id; assetHash: string; startFrame: number; srcStart: number; count: number; gain: number; fadeIn: number; fadeOut: number; assetRate: number }
export interface TrackRt { trackId: Id; order: number; channelIndex: number; instrument: InstrumentRt | null; audioClips: AudioClipRt[]; mono: boolean }
export interface EdgeRt { target: number; gain: number; tap: 'pre' | 'post' | 'out'; delay: number; sendId: Id | null }
export interface ChannelRt {
  id: Id; kind: Channel['kind']; name: string; gain: number; pan: number;
  audible: boolean; effects: EffectRt[]; edges: EdgeRt[];
  gainAutomation: AutomationRt | null; panAutomation: AutomationRt | null;
  chainLatency: number; inputLatency: number; mono: boolean;
}
export interface GraphPlan {
  sampleRate: number; graphRevision: number; projectId: Id;
  tracks: TrackRt[]; channels: ChannelRt[]; masterIndex: number;
  totalLatency: number; tailFrames: number;
  loop: { enabled: boolean; startFrame: number; endFrame: number };
  endFrame: number; // 곡의 마지막 이벤트/클립 끝
  diagnostics: string[];
}

/** 이벤트 payload 표 (불변, plan 준비 단계에서 생성) */
export interface EventTable {
  count: number;
  frame: Float64Array; kind: Uint8Array; track: Uint16Array; voice: Uint32Array;
  a: Float32Array; b: Float32Array; channel: Uint8Array; art: Int16Array; pad: Int16Array;
  articulations: string[]; padIds: string[]; params: string[];
  /** count 이후 트랙별 allNotesOff payload: index = count + trackIndex (frame=Infinity, 정상 공급되지 않음) */
  allOffBase: number;
}

export interface CompileOptions {
  sampleRate: number; profile?: Profile; graphRevision?: number;
  /** 자산 hash → 실제 존재/rate 정보. 없으면 missing 으로 진단 */
  assetInfo?: (hash: string) => { sampleRate: number; channels: number } | null;
  voiceIds?: Map<string, number>;
  maxCompensationSeconds?: number;
  /** 설치된 외부 플러그인 조회 (없으면 PLUGIN_MISSING) */
  plugins?: PluginResolver;
}

export interface CompileResult { ok: true; graph: GraphPlan; events: EventTable; diagnostics: string[]; compile: CompileDiagnostic[] }
export interface CompileError { ok: false; code: string; message: string }

function automationFor(p: Project, tm: TempoMap, sr: number, owner: 'channel' | 'plugin', ownerId: Id, parameterId: string, dflt: number): AutomationRt | null {
  const lane = p.automation.find((l) => l.enabled && l.target.owner === owner && l.target.ownerId === ownerId && l.target.parameterId === parameterId);
  if (!lane || lane.points.length === 0) return null;
  return { defaultValue: dflt, points: lane.points.map((pt) => ({ frame: tm.tickToFrame(pt.tick, sr), value: pt.value, linear: pt.interpolation === 'linear' })) };
}

/** 02 §4: 첫 점 이전 기본값, 점 사이 왼쪽 점 interpolation, 마지막 값 유지 */
export function evalAutomation(a: AutomationRt, frame: number): number {
  const pts = a.points;
  if (frame < pts[0].frame) return a.defaultValue;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].frame <= frame) lo = m; else hi = m - 1; }
  const p = pts[lo], q = pts[lo + 1];
  if (!q || !p.linear || q.frame === p.frame) return p.value;
  return p.value + ((q.value - p.value) * (frame - p.frame)) / (q.frame - p.frame);
}

/** block 단위 자동화 전개: 시작 구간만 이진 탐색하고 이후 선형 진행(evalAutomation 과 동일 값). */
export function fillAutomation(a: AutomationRt, startFrame: number, out: Float32Array, n: number, from = 0): void {
  const pts = a.points;
  let f = startFrame + from;
  let i = from;
  if (f < pts[0].frame) {
    const until = Math.min(n, from + (pts[0].frame - f));
    for (; i < until; i++) out[i] = a.defaultValue;
    f = startFrame + i;
    if (i >= n) return;
  }
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].frame <= f) lo = m; else hi = m - 1; }
  let seg = lo;
  while (i < n) {
    const p = pts[seg], q = pts[seg + 1];
    const segEnd = q ? q.frame : Infinity;
    const until = Math.min(n, i + (segEnd - (startFrame + i)));
    if (!q || !p.linear || q.frame === p.frame) { for (; i < until; i++) out[i] = p.value; }
    else { const slope = (q.value - p.value) / (q.frame - p.frame); for (; i < until; i++) out[i] = p.value + slope * (startFrame + i - p.frame); }
    seg++;
  }
}

function asState(j: Json): Record<string, Json> { return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, Json>) : {}; }

export function compileSource(s: Source): SourceCompileResult | null {
  switch (s.kind) {
    case 'tab': return compileTabSource(s);
    case 'midi': return compileMidiSource(s);
    case 'drum': return compileDrumSource(s);
    default: return null;
  }
}

export function compilePlan(project: Project, opts: CompileOptions, cache?: WeakMap<Source, SourceCompileResult>): CompileResult | CompileError {
  const sr = opts.sampleRate;
  const tm = new TempoMap(project.tempoMap);
  const diagnostics: string[] = [];
  const compileDiags: CompileDiagnostic[] = [];
  const sources = new Map(project.sources.map((s) => [s.id, s]));
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const plugins = new Map(project.plugins.map((x) => [x.instanceId, x]));
  const info = opts.assetInfo ?? (() => null);
  const wasmRef = (pl: PluginInstance, role: 'instrument' | 'effect'): WasmRef | null => {
    const r = opts.plugins?.(pl.pluginId, pl.pluginVersion);
    if (!r) return null;
    if (r.manifest.role !== role) { diagnostics.push(`PLUGIN_ROLE ${pl.pluginId} is ${r.manifest.role}, slot needs ${role}`); return null; }
    if (pl.stateVersion !== r.manifest.stateVersion) { diagnostics.push(`PLUGIN_MIGRATION_REQUIRED ${pl.pluginId} state v${pl.stateVersion} → v${r.manifest.stateVersion} — bypassed, state kept`); return null; }
    // 직렬화 가능한 필드만 담는다(Worklet 으로 보내는 그래프에 WebAssembly.Module 등이 섞이면 메시지가 폐기됨)
    return { key: r.key, manifest: r.manifest, memoryPages: r.memoryPages, stateJson: JSON.stringify(pl.state ?? null) };
  };
  const paramsOf = (pl: PluginInstance, m: PluginManifest | null) => {
    const ds = m?.parameters ?? [];
    const values = ds.map((d) => pl.parameters[d.id] ?? d.default);
    return { paramIds: ds.map((d) => d.id), values, automation: ds.map((d, k) => (d.automation === 'none' ? null : automationFor(project, tm, sr, 'plugin', pl.instanceId, d.id, values[k]))) };
  };

  // ---- 채널 위상 정렬 (sources → master) ----
  const idx = new Map(project.channels.map((c, i) => [c.id, i]));
  const indeg = new Array(project.channels.length).fill(0);
  const out = project.channels.map((c) => [...(c.output ? [c.output] : []), ...c.sends.map((s) => s.targetChannelId)].map((t) => idx.get(t)!));
  out.forEach((ts) => ts.forEach((t) => indeg[t]++));
  const order: number[] = []; const q = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  while (q.length) { const u = q.shift()!; order.push(u); for (const v of out[u]) if (--indeg[v] === 0) q.push(v); }
  if (order.length !== project.channels.length) return { ok: false, code: 'INVALID_ROUTING', message: 'routing cycle' };
  const newIndex = new Map(order.map((old, ni) => [old, ni]));
  const chOf = (id: Id) => newIndex.get(idx.get(id)!)!;

  // ---- solo 도달 규칙 ----
  const anySolo = project.channels.some((c) => c.solo && c.kind !== 'master');
  const soloedBus = new Set(project.channels.filter((c) => c.solo && c.kind === 'bus').map((c) => c.id));
  const reachesSoloBus = (c: Channel, seen = new Set<Id>()): boolean => {
    if (seen.has(c.id)) return false; seen.add(c.id);
    const targets = [...(c.output ? [c.output] : []), ...c.sends.map((s) => s.targetChannelId)];
    return targets.some((t) => soloedBus.has(t) || reachesSoloBus(project.channels[idx.get(t)!], seen));
  };

  // ---- tracks ----
  const tracks: TrackRt[] = [];
  const monoByChannel = new Map<Id, boolean>();
  const sortedTracks = [...project.tracks].sort((a, b) => a.order - b.order);
  for (const t of sortedTracks) {
    let instrument: InstrumentRt | null = null;
    let mono = true;
    if (t.instrumentSlot) {
      const pl = plugins.get(t.instrumentSlot)!;
      const st = asState(pl.state);
      const ext = pl.pluginId.startsWith('builtin.') ? null : wasmRef(pl, 'instrument');
      const supported = pl.pluginId === 'builtin.sampler' || !!ext;
      if (!supported) diagnostics.push(`PLUGIN_MISSING ${pl.pluginId}@${pl.pluginVersion} on track "${t.name}" — rendered silent`);
      const zones = (Array.isArray(st.zones) ? st.zones : []) as unknown as Record<string, Json>[];
      const pads = (Array.isArray(st.pads) ? st.pads : []) as unknown as Record<string, Json>[];
      const hashOf = (assetId: Json) => { const a = assets.get(String(assetId)); if (!a) return null; if (!info(a.sha256)) { diagnostics.push(`ASSET_MISSING ${a.sha256.slice(0, 12)} (sampler on "${t.name}")`); return null; } if (a.audio && a.audio.channels > 1) mono = false; return a.sha256; };
      instrument = {
        instanceId: pl.instanceId, pluginId: pl.pluginId, supported,
        zones: supported ? zones.map((z) => ({ id: String(z.id), assetHash: hashOf(z.assetId), rootPitch: Number(z.rootPitch), minPitch: Number(z.minPitch), maxPitch: Number(z.maxPitch), minVelocity: Number(z.minVelocity), maxVelocity: Number(z.maxVelocity), articulation: String(z.articulation ?? 'normal'), loopStartFrame: (z.loopStartFrame as number | null) ?? null, loopEndFrame: (z.loopEndFrame as number | null) ?? null })) : [],
        pads: supported ? pads.map((p) => ({ padId: String(p.padId), assetHash: hashOf(p.assetId), gain: Number(p.gain ?? 1), chokeGroup: (p.chokeGroup as number | null) ?? null })) : [],
        attackMs: pl.parameters.attackMs ?? Number(st.attackMs ?? 5), releaseMs: pl.parameters.releaseMs ?? Number(st.releaseMs ?? 80),
        gain: pl.parameters.gain ?? 1,
        gainAutomation: supported && !ext ? automationFor(project, tm, sr, 'plugin', pl.instanceId, 'gain', pl.parameters.gain ?? 1) : null,
        wasm: ext, sampleHashes: ext ? pl.assets.map((id) => hashOf(id)) : [],
        ...paramsOf(pl, ext?.manifest ?? null),
      };
    }
    const audioClips: AudioClipRt[] = [];
    for (const c of t.clips) {
      if (c.kind !== 'audio' || c.muted) continue;
      const s = sources.get(c.sourceId);
      const a = s?.kind === 'audio' ? assets.get(s.assetId) : undefined;
      if (!a?.audio) continue;
      const inf = info(a.sha256);
      if (!inf) { diagnostics.push(`ASSET_MISSING ${a.sha256.slice(0, 12)} (clip "${c.name}")`); continue; }
      if (a.audio.channels > 1) mono = false;
      const k = sr / a.audio.sampleRate;
      audioClips.push({ clipId: c.id, assetHash: a.sha256, startFrame: Math.round(c.startSeconds * sr), srcStart: Math.round(c.sourceStartFrame * k), count: Math.max(1, Math.round(c.sourceFrameCount * k)), gain: c.gain, fadeIn: Math.round(c.fadeInFrames * k), fadeOut: Math.round(c.fadeOutFrames * k), assetRate: a.audio.sampleRate });
    }
    monoByChannel.set(t.channelId, mono);
    tracks.push({ trackId: t.id, order: t.order, channelIndex: chOf(t.channelId), instrument, audioClips, mono });
  }

  // ---- channels + PDC ----
  const maxComp = Math.round((opts.maxCompensationSeconds ?? 2) * sr);
  const chans: ChannelRt[] = order.map((oi) => {
    const c = project.channels[oi];
    const isTrack = c.kind === 'track';
    const audible = !c.muted && (!isTrack || !anySolo || c.solo || reachesSoloBus(c));
    const effects: EffectRt[] = c.effects.map((eid) => {
      const pl = plugins.get(eid)!;
      const desc = BUILTIN_DESCRIPTORS[pl.pluginId];
      const st = asState(pl.state);
      const ext = desc ? null : wasmRef(pl, 'effect');
      if (!desc && !ext) diagnostics.push(`PLUGIN_MISSING ${pl.pluginId}@${pl.pluginVersion} on "${c.name}" — bypassed`);
      const descs = desc?.parameters ?? ext?.manifest.parameters ?? [];
      const ids = descs.map((d) => d.id);
      const values = descs.map((d) => pl.parameters[d.id] ?? d.default);
      const irAsset = typeof st.irAssetId === 'string' ? assets.get(st.irAssetId) : undefined;
      if (irAsset && !info(irAsset.sha256)) diagnostics.push(`ASSET_MISSING ${irAsset.sha256.slice(0, 12)} (reverb IR) — synthetic IR used`);
      return {
        instanceId: pl.instanceId, pluginId: pl.pluginId, paramIds: ids, values, bypass: !desc && !ext, wasm: ext,
        automation: ids.map((pid, k) => (descs[k].automation === 'none' ? null : automationFor(project, tm, sr, 'plugin', pl.instanceId, pid, values[k]))),
        lookaheadMs: pl.parameters.lookaheadMs ?? 0, predelayMs: pl.parameters.predelayMs ?? 0,
        irAssetHash: irAsset && info(irAsset.sha256) ? irAsset.sha256 : null,
      };
    });
    const chainLatency = effects.reduce((s, e) => s + effectLatency(e, sr), 0);
    return {
      id: c.id, kind: c.kind, name: c.name, gain: c.gain, pan: c.pan, audible, effects, edges: [],
      gainAutomation: automationFor(project, tm, sr, 'channel', c.id, 'gain', c.gain),
      panAutomation: automationFor(project, tm, sr, 'channel', c.id, 'pan', c.pan),
      chainLatency, inputLatency: 0, mono: isTrack ? (monoByChannel.get(c.id) ?? true) : false,
    };
  });
  const outLat = new Array(chans.length).fill(0);
  for (let i = 0; i < chans.length; i++) {
    const c = project.channels[order[i]];
    outLat[i] = chans[i].inputLatency + chans[i].chainLatency;
    const add = (targetId: Id, gain: number, tap: EdgeRt['tap'], sendId: Id | null) => {
      const ti = chOf(targetId);
      chans[i].edges.push({ target: ti, gain, tap, delay: 0, sendId });
      chans[ti].inputLatency = Math.max(chans[ti].inputLatency, outLat[i]);
    };
    if (c.output) add(c.output, 1, 'out', null);
    for (const s of c.sends) add(s.targetChannelId, s.gain, s.tap, s.id);
  }
  for (let i = 0; i < chans.length; i++) for (const e of chans[i].edges) e.delay = chans[e.target].inputLatency - outLat[i];
  const masterIndex = chOf(project.masterChannelId);
  const totalLatency = chans[masterIndex].inputLatency + chans[masterIndex].chainLatency;
  for (const c of chans) for (const e of c.edges) if (e.delay > maxComp) return { ok: false, code: 'PDC_LIMIT', message: `latency compensation ${e.delay} frames exceeds ${maxComp}` };
  if (totalLatency > maxComp) return { ok: false, code: 'PDC_LIMIT', message: `total latency ${totalLatency} exceeds ${maxComp}` };
  const tailFrames = Math.min(10 * sr, Math.max(Math.round(sr * 0.25), ...chans.flatMap((c) => c.effects.map((e) => effectTail(e, sr)))));

  // ---- events ----
  const all: (PerformanceEvent & { trackIndex: number; order: number })[] = [];
  let endTick = 0;
  sortedTracks.forEach((t, ti) => {
    for (const c of t.clips) {
      if (c.kind !== 'music') continue;
      endTick = Math.max(endTick, c.startTick + c.durationTicks);
      const s = sources.get(c.sourceId)!;
      let compiled = cache?.get(s);
      if (!compiled) { compiled = compileSource(s) ?? { events: [], diagnostics: [] }; cache?.set(s, compiled); }
      compileDiags.push(...compiled.diagnostics);
      for (const e of expandClip(t.id, c as MusicClip, s.id, (s as { lengthTicks: number }).lengthTicks, compiled.events)) all.push({ ...e, trackIndex: ti, order: t.order });
    }
  });
  const frameOf = (e: PerformanceEvent) => tm.tickToFrame(e.tick, sr, e.timeOffsetSeconds);
  const withFrame = all.map((e) => ({ e, f: frameOf(e) }));
  withFrame.sort((x, y) => x.f - y.f || KIND_PRIORITY[x.e.kind] - KIND_PRIORITY[y.e.kind] || x.e.order - y.e.order || (x.e.clipId < y.e.clipId ? -1 : x.e.clipId > y.e.clipId ? 1 : 0) || (x.e.sourceEventId < y.e.sourceEventId ? -1 : x.e.sourceEventId > y.e.sourceEventId ? 1 : 0) || x.e.occurrence - y.e.occurrence);
  const n = withFrame.length;
  const N = n + sortedTracks.length;
  const table: EventTable = {
    count: n, frame: new Float64Array(N), kind: new Uint8Array(N), track: new Uint16Array(N), voice: new Uint32Array(N),
    a: new Float32Array(N), b: new Float32Array(N), channel: new Uint8Array(N), art: new Int16Array(N).fill(-1), pad: new Int16Array(N).fill(-1),
    articulations: [], padIds: [], params: [], allOffBase: n,
  };
  for (let ti = 0; ti < sortedTracks.length; ti++) { table.frame[n + ti] = Infinity; table.kind[n + ti] = EV_ALL_OFF; table.track[n + ti] = ti; }
  const intern = (list: string[], s: string) => { let i = list.indexOf(s); if (i < 0) { i = list.length; list.push(s); } return i; };
  const voiceIds = opts.voiceIds ?? new Map<string, number>();
  const vid = (k: string) => { let v = voiceIds.get(k); if (v === undefined) { v = voiceIds.size + 1; voiceIds.set(k, v); } return v; };
  withFrame.forEach(({ e, f }, i) => {
    table.frame[i] = f; table.track[i] = e.trackIndex;
    switch (e.kind) {
      case 'noteOn': table.kind[i] = EV_NOTE_ON; table.voice[i] = vid(e.voiceKey); table.a[i] = e.pitch; table.b[i] = e.velocity; table.channel[i] = e.channel; table.art[i] = intern(table.articulations, e.articulation); table.pad[i] = e.padId ? intern(table.padIds, e.padId) : -1; break;
      case 'noteOff': table.kind[i] = EV_NOTE_OFF; table.voice[i] = vid(e.voiceKey); break;
      case 'cc': table.kind[i] = EV_CC; table.a[i] = e.controller; table.b[i] = e.value; table.channel[i] = e.channel; break;
      case 'pitchBend': table.kind[i] = EV_PITCH_BEND; table.b[i] = e.value; table.channel[i] = e.channel; break;
      case 'expression': table.kind[i] = EV_EXPRESSION; table.voice[i] = vid(e.voiceKey); table.a[i] = intern(table.params, e.parameterId); table.b[i] = e.value; break;
    }
  });

  let endFrame = n ? table.frame[n - 1] : 0;
  for (const t of tracks) for (const c of t.audioClips) endFrame = Math.max(endFrame, c.startFrame + c.count);
  endFrame = Math.max(endFrame, tm.tickToFrame(endTick, sr));
  const loopOn = project.loop.enabled;
  return {
    ok: true,
    graph: {
      sampleRate: sr, graphRevision: opts.graphRevision ?? 1, projectId: project.id,
      tracks, channels: chans, masterIndex, totalLatency, tailFrames,
      loop: { enabled: loopOn, startFrame: tm.tickToFrame(project.loop.startTick, sr), endFrame: tm.tickToFrame(project.loop.endTick, sr) },
      endFrame, diagnostics,
    },
    events: table, diagnostics: [...diagnostics, ...dedupe(compileDiags.map((d) => `${d.code}: ${d.message}`))], compile: compileDiags,
  };
}

function dedupe(a: string[]): string[] { return [...new Set(a)]; }

export function effectLatency(e: EffectRt, sr: number): number {
  if (e.bypass) return 0;
  if (e.wasm) return e.wasm.manifest.latencyFrames;
  if (e.pluginId === 'builtin.compressor') return Math.round((e.lookaheadMs * sr) / 1000);
  if (e.pluginId === 'builtin.reverb') return REVERB_LATENCY;
  return 0;
}
function effectTail(e: EffectRt, sr: number): number {
  if (e.wasm) return Math.min(e.wasm.manifest.tailFrames ?? 10 * sr, 10 * sr) + e.wasm.manifest.latencyFrames;
  if (e.pluginId === 'builtin.reverb') return Math.round(sr * 1) + Math.round((e.predelayMs * sr) / 1000) + REVERB_LATENCY;
  if (e.pluginId === 'builtin.compressor') return Math.round(sr * 0.1);
  if (e.pluginId === 'builtin.eq') return Math.round(sr * 0.05);
  return 0;
}

export const CHANNEL_PARAM_IDS = CHANNEL_PARAMETERS.map((d) => d.id);
export { BUILTIN_DESCRIPTORS };

/** 장시간 렌더/배치를 위한 메모리 추정 (01 §9) */
export function estimatePcmBytes(graph: GraphPlan, info: (hash: string) => { frames: number; channels: number } | null): number {
  const hashes = new Set<string>();
  for (const t of graph.tracks) {
    for (const c of t.audioClips) hashes.add(c.assetHash);
    for (const z of t.instrument?.zones ?? []) if (z.assetHash) hashes.add(z.assetHash);
    for (const p of t.instrument?.pads ?? []) if (p.assetHash) hashes.add(p.assetHash);
  }
  let total = 0;
  for (const h of hashes) { const i = info(h); if (i) total += i.frames * i.channels * 4; }
  return total;
}

export type { AudioClip };
