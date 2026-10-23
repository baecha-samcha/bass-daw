// Worker block renderer → WAV 스트리밍 (01 §8). 전체 곡 PCM 을 메모리에 올리지 않는다.
import type { Project, Tick } from '@bass-daw/schemas';
import { TempoMap } from '@bass-daw/music-core';
import { compilePlan, POLYPHONY, type Profile, type GraphPlan, type EventTable, type PluginResolver } from './plan.ts';
import { RenderCore } from './core.ts';
import type { Pcm, WavFormat } from './wav.ts';
import { wavHeader, encodeBlock, seededRng, wavDataBytes } from './wav.ts';
import { Sha256 } from '@bass-daw/schemas';

export const ENGINE_VERSION = 'bass-daw-engine/0.5.0';

export interface ExportOptions {
  startTick: Tick; endTick: Tick; sampleRate: 44100 | 48000 | 96000;
  format: 'wav-pcm24' | 'wav-float32'; tailSeconds: number;
  seed: number; allowFallbacks: boolean;
}
export interface RenderReceipt { outputAssetHash: string; frames: number; diagnostics: string[]; engineVersion: string; pluginHashes: string[]; clipped: number; peak: number }

export interface OfflineInput { project: Project; pcm: Map<string, Pcm>; profile?: Profile; plugins?: PluginResolver; wasm?: Map<string, WebAssembly.Module>; pluginHashes?: string[]; blockFrames?: number; isCancelled?: () => boolean; onProgress?: (done: number, total: number) => void }

export type OfflineResult = { ok: true; receipt: RenderReceipt } | { ok: false; code: string; message: string; diagnostics: string[] };

/** 출력 chunk 를 sink 로 흘린다(헤더 먼저). sink 는 OPFS writable 또는 테스트용 수집기. */
export async function renderToWav(input: OfflineInput, opts: ExportOptions, sink: (chunk: Uint8Array) => void | Promise<void>): Promise<OfflineResult> {
  const sr = opts.sampleRate;
  const pcm = input.pcm;
  const plan = compilePlan(input.project, { sampleRate: sr, profile: input.profile, plugins: input.plugins, assetInfo: (h) => { const p = pcm.get(h); return p ? { sampleRate: p.sampleRate, channels: p.channels.length } : null; } });
  if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, diagnostics: [] };
  const missing = plan.diagnostics.filter((d) => d.startsWith('ASSET_MISSING') || d.startsWith('PLUGIN_MISSING'));
  if (missing.length && !opts.allowFallbacks) return { ok: false, code: 'EXPORT_BLOCKED', message: 'missing assets or plugins; enable fallbacks to export with silence/bypass', diagnostics: missing };
  const tm = new TempoMap(input.project.tempoMap);
  const startFrame = tm.tickToFrame(opts.startTick, sr);
  const endFrame = tm.tickToFrame(opts.endTick, sr);
  if (endFrame <= startFrame) return { ok: false, code: 'EXPORT_RANGE', message: 'end must be after start', diagnostics: [] };
  const tail = Math.round(Math.min(10, Math.max(0, opts.tailSeconds)) * sr);
  const outFrames = endFrame - startFrame + tail;
  const nc = 2;
  if (wavDataBytes(opts.format, nc, outFrames) + 36 > 0xffffffff) return { ok: false, code: 'EXPORT_LIMIT', message: 'WAV would exceed RIFF 4GiB; shorten the range', diagnostics: [] };
  const latency = plan.graph.totalLatency;
  const B = input.blockFrames ?? 512;
  const core = new RenderCore(withoutLoop(plan.graph), pcm, { maxBlock: B, polyphony: POLYPHONY[input.profile ?? 'high'], wasm: input.wasm });
  core.setEvents(plan.events);
  // 시작 전 진행 중 상태 재구성: 시작 frame 이전 CC/pitch bend 를 적용(노트는 retrigger 하지 않음)
  primeControllers(core, plan.events, startFrame);
  core.locate(startFrame, true);
  const rng = seededRng(opts.seed);
  const header = wavHeader(opts.format, nc, sr, outFrames);
  const hasher = new Sha256();
  hasher.update(header); await sink(header);
  const out = [new Float32Array(B), new Float32Array(B)];
  const stats = { clipped: 0 };
  let peak = 0;
  // latency pre-roll 을 추가 렌더하고 정확히 제거한다 (tail 과 구분)
  let skip = latency; let written = 0;
  const total = outFrames + latency;
  let rendered = 0;
  while (written < outFrames) {
    if (input.isCancelled?.()) return { ok: false, code: 'EXPORT_CANCELLED', message: 'cancelled', diagnostics: [] };
    const n = Math.min(B, total - rendered);
    core.renderBlock(out, n);
    rendered += n;
    let off = 0;
    if (skip > 0) { off = Math.min(skip, n); skip -= off; }
    const m = Math.min(n - off, outFrames - written);
    if (m > 0) {
      const chans = [out[0].subarray(off, off + m), out[1].subarray(off, off + m)];
      for (const c of chans) for (let i = 0; i < m; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
      const bytes = encodeBlock(opts.format, chans, m, rng, stats);
      hasher.update(bytes); await sink(bytes);
      written += m;
    }
    if ((rendered / B) % 64 === 0) { input.onProgress?.(written, outFrames); await Promise.resolve(); }
  }
  input.onProgress?.(outFrames, outFrames);
  const diags = [...plan.diagnostics];
  if (core.counters.faults) diags.push(`DSP_FAULT x${core.counters.faults}`);
  for (const f of core.pluginFaults()) diags.push(`PLUGIN_FAULT ${f.instanceId}: ${f.reason} — bypassed (instrument silent / effect dry)`);
  if (core.counters.voiceSteals) diags.push(`VOICE_STEAL x${core.counters.voiceSteals}`);
  if (core.counters.articulationFallbacks) diags.push(`ARTICULATION_FALLBACK x${core.counters.articulationFallbacks}`);
  if (stats.clipped) diags.push(`CLAMPED_SAMPLES ${stats.clipped} (pcm24 clamp; no normalization)`);
  return { ok: true, receipt: { outputAssetHash: hasher.digestHex(), frames: outFrames, diagnostics: diags, engineVersion: ENGINE_VERSION, pluginHashes: input.pluginHashes ?? [], clipped: stats.clipped, peak } };
}

function withoutLoop(g: GraphPlan): GraphPlan { return { ...g, loop: { ...g.loop, enabled: false } }; }

function primeControllers(core: RenderCore, ev: EventTable, startFrame: number) {
  for (let i = 0; i < ev.count && ev.frame[i] < startFrame; i++) {
    const k = ev.kind[i];
    if (k === 3 || k === 4) core.applyEvent(i);
  }
}

/** 장시간 export 의 메모리 상한 계산: PCM 캐시 + block 버퍼 (출력 전체를 메모리에 두지 않음) */
export function exportMemoryEstimate(pcmBytes: number, blockFrames = 512): number {
  return pcmBytes + blockFrames * 2 * 4 * 64;
}
