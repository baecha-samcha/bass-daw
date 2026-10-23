// 외부 WASM 플러그인을 RenderCore 의 effect/instrument 로 감싼다(03 §5).
// fault(trap/NaN 등): effect → 지연 보상된 dry bypass, instrument → 무음. 5ms 전환, project state 는 그대로.
// 같은 렌더 스레드에서 실행되므로 무한 루프·CPU 초과는 격리되지 않는다(검토된 고정 hash 만 실행).
import type { PluginManifest } from '@bass-daw/schemas';
import { WasmPluginRuntime, PluginPrepareError, type PluginEvent, type SampleBinding } from '@bass-daw/plugin-api';
import type { EffectDsp } from './types.ts';
import { DelayLine } from './delay.ts';
import type { SamplerCounters } from './sampler.ts';

const RAMP_MS = 5;

export class WasmEffectDsp implements EffectDsp {
  readonly latencyFrames: number;
  readonly tailFrames: number;
  diagnostics: string[] = [];
  runtime: WasmPluginRuntime | null = null;
  fault: string | null = null;
  bypass = false;
  private dryDelay: DelayLine; private dry: Float32Array[]; private ramp = 0; private rampLen: number;
  private noEvents: PluginEvent[] = [];

  /** module=null: 준비 단계에서 컴파일되지 않음 → 여기서 컴파일하지 않고 'not-prepared' 보상 bypass */
  constructor(module: WebAssembly.Module | null, readonly manifest: PluginManifest, fs: number, memoryPages: number, stateJson: string, readonly instanceId: string) {
    this.latencyFrames = manifest.latencyFrames;
    this.tailFrames = Math.min(manifest.tailFrames ?? 10 * fs, 10 * fs);
    this.dryDelay = new DelayLine(this.latencyFrames);
    this.dry = [new Float32Array(4096), new Float32Array(4096)];
    this.rampLen = Math.max(1, Math.round((RAMP_MS * fs) / 1000));
    if (!module) { this.fault = 'not-prepared'; this.diagnostics.push(`PLUGIN_NOT_PREPARED ${manifest.pluginId}: module not compiled in the prepare phase`); return; }
    try { this.runtime = new WasmPluginRuntime(module, manifest, fs, memoryPages); this.runtime.prepare(stateJson, []); }
    catch (e) { this.fault = e instanceof PluginPrepareError ? e.code : 'PREPARE_FAILED'; this.diagnostics.push(`PLUGIN_PREPARE ${manifest.pluginId}: ${(e as Error).message}`); this.runtime = null; }
  }

  process(io: Float32Array[], frames: number, params: Float32Array[]): void {
    if (this.dry[0].length < frames) this.dry = [new Float32Array(frames), new Float32Array(frames)];
    this.dry[0].set(io[0].subarray(0, frames)); this.dry[1].set(io[1].subarray(0, frames));
    this.dryDelay.process(this.dry, frames); // dry 경로도 같은 latency 로 지연(보상된 bypass)
    const active = !!this.runtime && !this.fault && !this.bypass;
    if (active) {
      const ok = this.runtime!.process(io, frames, this.noEvents, 0, params);
      if (!ok) { this.fault = this.runtime!.faulted; this.ramp = this.rampLen; for (let c = 0; c < 2; c++) io[c].fill(0, 0, frames); }
      else return;
    }
    // bypass: 5ms 동안 0→dry 로 전환
    for (let i = 0; i < frames; i++) {
      const g = this.ramp > 0 ? 1 - this.ramp-- / this.rampLen : 1;
      io[0][i] = this.dry[0][i] * g; io[1][i] = this.dry[1][i] * g;
    }
  }
  reset(): void { this.runtime?.reset(); this.dryDelay.reset(); }
}

/** SamplerDsp 와 같은 이벤트 인터페이스의 WASM instrument. 이벤트는 다음 render 구간 offset 0 에 전달된다. */
export class WasmInstrumentDsp {
  runtime: WasmPluginRuntime | null = null;
  fault: string | null = null;
  bypass = false;
  counters: SamplerCounters = { voiceSteals: 0, articulationFallbacks: 0, missingSamples: 0, stuckVoices: 0 };
  private queue: PluginEvent[] = Array.from({ length: 4096 }, () => ({ offset: 0, type: 0, voice: 0, channel: 0, d0: 0, d1: 0, d2: 0 }));
  private q = 0;
  private scratch = [new Float32Array(4096), new Float32Array(4096)];
  private params: Float32Array[];
  private sounding = new Set<number>();
  diagnostics: string[] = [];

  constructor(module: WebAssembly.Module | null, readonly manifest: PluginManifest, fs: number, memoryPages: number, stateJson: string, samples: SampleBinding[], readonly instanceId: string,
    private paramFill: (k: number, out: Float32Array, start: number, end: number) => void) {
    this.params = manifest.parameters.map(() => new Float32Array(4096));
    if (!module) { this.fault = 'not-prepared'; this.diagnostics.push(`PLUGIN_NOT_PREPARED ${manifest.pluginId}: module not compiled in the prepare phase`); return; }
    try { this.runtime = new WasmPluginRuntime(module, manifest, fs, memoryPages); this.runtime.prepare(stateJson, samples); }
    catch (e) { this.fault = e instanceof PluginPrepareError ? e.code : 'PREPARE_FAILED'; this.diagnostics.push(`PLUGIN_PREPARE ${manifest.pluginId}: ${(e as Error).message}`); this.runtime = null; }
  }

  get activeVoices(): number { return this.sounding.size; }
  private push(type: number, voice: number, channel: number, d0: number, d1: number, d2: number) {
    if (this.q >= this.queue.length) return;
    const e = this.queue[this.q++]; e.offset = 0; e.type = type; e.voice = voice; e.channel = channel; e.d0 = d0; e.d1 = d1; e.d2 = d2;
  }
  noteOn(voiceId: number, pitch: number, velocity: number, channel: number, articulation: string, _padId: string | null): void {
    let art = this.manifest.articulations.indexOf(articulation);
    if (art < 0) { art = 0; this.counters.articulationFallbacks++; }
    this.sounding.add(voiceId);
    this.push(1, voiceId, channel, pitch, velocity / 127, art);
  }
  noteOff(voiceId: number): void { this.sounding.delete(voiceId); this.push(2, voiceId, 0, 0, 0, 0); }
  cc(channel: number, controller: number, value: number): void { this.push(3, 0, channel, controller, value, 0); }
  pitchBend(channel: number, value: number): void { this.push(4, 0, channel, value, 0, 0); }
  expression(voiceId: number, parameterId: string, value: number): void {
    const k = this.manifest.voiceExpressions.findIndex((d) => d.id === parameterId);
    if (k < 0) { this.counters.articulationFallbacks++; return; }
    this.push(5, voiceId, 0, k, value, 0);
  }
  allNotesOff(): void { this.sounding.clear(); this.push(6, 0, 0, 0, 0, 0); }
  hardReset(): void { this.sounding.clear(); this.q = 0; this.runtime?.reset(); }

  render(out: Float32Array[], start: number, end: number, _gain: Float32Array | null): void {
    const n = end - start;
    if (!this.runtime || this.fault || this.bypass || n <= 0) { this.q = 0; return; } // instrument fault → 무음
    for (let k = 0; k < this.params.length; k++) this.paramFill(k, this.params[k], start, end);
    const views = this.params.map((p) => p.subarray(start, end));
    const s = this.scratch;
    if (!this.runtime.process(s, n, this.queue, this.q, views)) { this.fault = this.runtime.faulted; this.q = 0; return; }
    this.q = 0;
    for (let i = 0; i < n; i++) { out[0][start + i] += s[0][i]; out[1][start + i] += s[1][i]; }
  }
}
