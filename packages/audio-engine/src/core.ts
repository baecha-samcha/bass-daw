// RenderCore: 실시간 Worklet 과 offline renderer 가 공유하는 단일 DSP 그래프 (01 §2, §6, §8).
// process 경로(renderBlock)는 초기 할당 이후 동적 대량 할당·IO·JSON·log·await 를 하지 않는다.
import type { GraphPlan, EventTable, EffectRt, AutomationRt } from './plan.ts';
import { fillAutomation, EV_NOTE_ON, EV_NOTE_OFF, EV_CC, EV_PITCH_BEND, EV_EXPRESSION, EV_ALL_OFF } from './plan.ts';
import type { Pcm } from './wav.ts';
import { SamplerDsp } from './dsp/sampler.ts';
import { WasmEffectDsp, WasmInstrumentDsp } from './dsp/wasm.ts';
import { EqDsp } from './dsp/biquad.ts';
import { CompressorDsp } from './dsp/compressor.ts';
import { ReverbDsp, syntheticIr } from './dsp/reverb.ts';
import { DelayLine } from './dsp/delay.ts';
import type { EffectDsp } from './dsp/types.ts';

export interface CoreCounters {
  late: number; stale: number; underruns: number; faults: number; voiceSteals: number;
  articulationFallbacks: number; missingSamples: number; clippedPeaks: number; pluginFaults: number;
}
/** wasm: 준비 단계에서 컴파일된 모듈(WasmModuleCache.modules). RenderCore 는 읽기만 한다. */
export interface CoreOptions { maxBlock: number; polyphony: number; wasm?: ReadonlyMap<string, WebAssembly.Module> }

const SMOOTH_MS = 5;

interface EffectNode { rt: EffectRt; dsp: EffectDsp | null; params: Float32Array[]; faulted: boolean; bypassDelay: DelayLine | null }
interface ChannelNode {
  buf: Float32Array[]; pre: Float32Array[]; effects: EffectNode[];
  gainCur: number; panCur: number; gainTarget: number; panTarget: number;
  gainBuf: Float32Array; panBuf: Float32Array;
  edgeDelays: (DelayLine | null)[]; edgeTmp: Float32Array[];
  peak: Float32Array; faulted: boolean;
}

export class RenderCore {
  readonly sr: number;
  graph: GraphPlan;
  events: EventTable | null = null;
  timelineFrame = 0;
  counters: CoreCounters = { late: 0, stale: 0, underruns: 0, faults: 0, voiceSteals: 0, articulationFallbacks: 0, missingSamples: 0, clippedPeaks: 0, pluginFaults: 0 };
  readonly maxBlock: number;
  private samplers: (SamplerDsp | WasmInstrumentDsp | null)[];
  private wasm: ReadonlyMap<string, WebAssembly.Module>;
  private trackBuf: Float32Array[][];
  private channels: ChannelNode[];
  private pcm: Map<string, Pcm>;
  private instGain: Float32Array;
  private fadeLen: number;
  private evCursor = 0;
  masterPeak = new Float32Array(2);

  constructor(graph: GraphPlan, pcm: Map<string, Pcm>, opts: CoreOptions) {
    this.sr = graph.sampleRate; this.graph = graph; this.pcm = pcm; this.maxBlock = opts.maxBlock;
    this.fadeLen = Math.round((SMOOTH_MS * this.sr) / 1000);
    const B = opts.maxBlock;
    this.instGain = new Float32Array(B);
    this.wasm = opts.wasm ?? new Map();
    this.samplers = graph.tracks.map((t) => {
      if (!t.instrument || !t.instrument.supported) return null;
      const inst = t.instrument;
      if (inst.wasm) {
        const mod = this.wasm.get(inst.wasm.key) ?? null; // 없으면 'not-prepared'(무음). 여기서 컴파일하지 않는다.
        const samples = inst.sampleHashes.map((h) => { const p = h ? pcm.get(h) : undefined; return p ? { channels: p.channels, sampleRate: p.sampleRate } : { channels: [new Float32Array(2)], sampleRate: this.sr }; });
        return new WasmInstrumentDsp(mod, inst.wasm.manifest, this.sr, inst.wasm.memoryPages, inst.wasm.stateJson, samples, inst.instanceId, (k, out, start, end) => {
          const a = inst.automation[k];
          if (a) fillAutomation(a, this.timelineFrame, out, end, start); else out.fill(inst.values[k], start, end);
        });
      }
      const s = new SamplerDsp(this.sr, opts.polyphony,
        t.instrument.zones.map((z) => ({ id: z.id, pcm: z.assetHash ? pcm.get(z.assetHash) ?? null : null, rootPitch: z.rootPitch, minPitch: z.minPitch, maxPitch: z.maxPitch, minVelocity: z.minVelocity, maxVelocity: z.maxVelocity, articulation: z.articulation, loopStart: z.loopStartFrame, loopEnd: z.loopEndFrame })),
        t.instrument.pads.map((p) => ({ padId: p.padId, pcm: p.assetHash ? pcm.get(p.assetHash) ?? null : null, gain: p.gain, chokeGroup: p.chokeGroup })));
      s.attackMs = t.instrument.attackMs; s.releaseMs = t.instrument.releaseMs;
      return s;
    });
    this.trackBuf = graph.tracks.map(() => [new Float32Array(B), new Float32Array(B)]);
    this.channels = graph.channels.map((c) => ({
      buf: [new Float32Array(B), new Float32Array(B)], pre: [new Float32Array(B), new Float32Array(B)],
      effects: c.effects.map((e) => this.makeEffect(e, B)),
      gainCur: c.gain, panCur: c.pan, gainTarget: c.gain, panTarget: c.pan,
      gainBuf: new Float32Array(B), panBuf: new Float32Array(B),
      edgeDelays: c.edges.map((e) => (e.delay > 0 ? new DelayLine(e.delay) : null)),
      edgeTmp: [new Float32Array(B), new Float32Array(B)],
      peak: new Float32Array(2), faulted: false,
    }));
  }

  private makeEffect(e: EffectRt, B: number): EffectNode {
    let dsp: EffectDsp | null = null;
    if (!e.bypass && e.wasm) {
      const mod = this.wasm.get(e.wasm.key) ?? null; // 없으면 'not-prepared' 보상 bypass. 여기서 컴파일하지 않는다.
      dsp = new WasmEffectDsp(mod, e.wasm.manifest, this.sr, e.wasm.memoryPages, e.wasm.stateJson, e.instanceId);
    } else if (!e.bypass) {
      if (e.pluginId === 'builtin.eq') dsp = new EqDsp(this.sr);
      else if (e.pluginId === 'builtin.compressor') dsp = new CompressorDsp(this.sr, e.lookaheadMs);
      else if (e.pluginId === 'builtin.reverb') {
        const ir = e.irAssetHash ? this.pcm.get(e.irAssetHash)?.channels : undefined;
        dsp = new ReverbDsp(this.sr, ir ?? syntheticIr(this.sr), e.predelayMs);
      }
    }
    return { rt: e, dsp, params: e.paramIds.map(() => new Float32Array(B)), faulted: false, bypassDelay: null };
  }

  setEvents(t: EventTable | null): void { this.events = t; this.evCursor = 0; }

  /** 수동 파라미터 변경(lane 비활성일 때 영속값, 활성일 때 일시 preview) — gain/pan 5ms smoothing */
  setChannelParam(channelIndex: number, param: 'gain' | 'pan', value: number): void {
    const c = this.channels[channelIndex]; if (!c) return;
    if (param === 'gain') c.gainTarget = value; else c.panTarget = value;
  }
  setEffectParam(channelIndex: number, effectIndex: number, paramIndex: number, value: number): void {
    const e = this.channels[channelIndex]?.effects[effectIndex]; if (e) e.rt.values[paramIndex] = value;
  }
  setAudible(channelIndex: number, audible: boolean): void { const c = this.graph.channels[channelIndex]; if (c) c.audible = audible; }

  /** seek/stop/loop: voice 종료(5ms ramp), effect tail reset, 5ms fade-in */
  locate(frame: number, hard = false): void {
    this.timelineFrame = frame;
    for (const s of this.samplers) if (s) { if (hard) s.hardReset(); else s.allNotesOff(); }
    for (const c of this.channels) for (const e of c.effects) e.dsp?.reset();
    for (const c of this.channels) for (const d of c.edgeDelays) d?.reset();
    // voice 는 5ms ramp 로 종료된다. effect tail 은 reset(루프 전후 리버브 연속성은 v1 비보장, 01 §4).
    if (this.events) {
      // 이진 탐색으로 이벤트 커서 재배치 (offline 직접 공급 경로)
      let lo = 0, hi = this.events.count;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.events.frame[m] < frame) lo = m + 1; else hi = m; }
      this.evCursor = lo;
    }
  }

  panic(): void { for (const s of this.samplers) s?.hardReset(); }

  get activeVoices(): number { let n = 0; for (const s of this.samplers) if (s) n += s.activeVoices; return n; }

  /** 이벤트 1개 적용 (payload index) */
  applyEvent(i: number): void {
    const ev = this.events!; const t = ev.track[i]; const s = this.samplers[t];
    if (!s) return;
    switch (ev.kind[i]) {
      case EV_NOTE_ON: s.noteOn(ev.voice[i], ev.a[i], ev.b[i], ev.channel[i], ev.art[i] >= 0 ? ev.articulations[ev.art[i]] : 'normal', ev.pad[i] >= 0 ? ev.padIds[ev.pad[i]] : null); break;
      case EV_NOTE_OFF: s.noteOff(ev.voice[i]); break;
      case EV_CC: s.cc(ev.channel[i], ev.a[i], ev.b[i]); break;
      case EV_PITCH_BEND: s.pitchBend(ev.channel[i], ev.b[i]); break;
      case EV_EXPRESSION: s.expression(ev.voice[i], ev.params[ev.a[i]], ev.b[i]); break;
      case EV_ALL_OFF: s.allNotesOff(); break;
    }
  }

  /**
   * 한 block 렌더. pending: block 내부 [offset, payloadIndex] 쌍(offset 오름차순, offset<frames).
   * offline 경로에서는 pending=null 로 두면 events 표를 timelineFrame 기준으로 직접 소비한다.
   */
  renderBlock(out: Float32Array[], frames: number, pending: Int32Array | null = null, pendingCount = 0): void {
    const B = frames;
    for (const tb of this.trackBuf) { tb[0].fill(0, 0, B); tb[1].fill(0, 0, B); }
    // 1) instrument: 이벤트 offset 에서 분할 렌더
    let cursor = 0;
    const emit = (offset: number, payload: number) => {
      if (offset > cursor) this.renderInstruments(cursor, offset);
      cursor = offset;
      this.applyEvent(payload);
    };
    if (pending) {
      for (let k = 0; k < pendingCount; k++) emit(pending[2 * k], pending[2 * k + 1]);
    } else if (this.events) {
      const ev = this.events; const end = this.timelineFrame + B;
      while (this.evCursor < ev.count && ev.frame[this.evCursor] < end) {
        const f = ev.frame[this.evCursor];
        if (f < this.timelineFrame) { this.counters.late++; if (ev.kind[this.evCursor] === EV_NOTE_OFF) this.applyEvent(this.evCursor); this.evCursor++; continue; }
        emit(f - this.timelineFrame, this.evCursor++);
      }
    }
    if (cursor < B) this.renderInstruments(cursor, B);
    // 2) audio clips (초 앵커 → timeline frame)
    this.graph.tracks.forEach((t, ti) => { for (const c of t.audioClips) this.renderClip(c, this.trackBuf[ti], B); });
    // 3) mixer
    for (const c of this.channels) { c.buf[0].fill(0, 0, B); c.buf[1].fill(0, 0, B); }
    this.graph.tracks.forEach((t, ti) => {
      const cb = this.channels[t.channelIndex].buf, tb = this.trackBuf[ti];
      for (let i = 0; i < B; i++) { cb[0][i] += tb[0][i]; cb[1][i] += tb[1][i]; }
    });
    for (let ci = 0; ci < this.channels.length; ci++) this.processChannel(ci, B);
    const m = this.channels[this.graph.masterIndex].buf;
    const pk = this.masterPeak;
    for (let i = 0; i < B; i++) {
      const l = m[0][i], r = m[1][i];
      out[0][i] = l; out[1][i] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pk[0]) pk[0] = al; if (ar > pk[1]) pk[1] = ar;
      if (al > 1 || ar > 1) this.counters.clippedPeaks++;
    }
    this.timelineFrame += B;
    this.syncCounters();
  }

  /** 외부 플러그인 fault 목록(instanceId → 사유). faulted→bypassed, 자동 재시작 없음. */
  pluginFaults(): { instanceId: string; reason: string }[] {
    const out: { instanceId: string; reason: string }[] = [];
    for (const s of this.samplers) if (s instanceof WasmInstrumentDsp && s.fault) out.push({ instanceId: s.instanceId, reason: s.fault });
    for (const c of this.channels) for (const e of c.effects) if (e.dsp instanceof WasmEffectDsp && e.dsp.fault) out.push({ instanceId: e.dsp.instanceId, reason: e.dsp.fault });
    return out;
  }

  /** 수동 bypass (runtime 전용, 영속 아님) */
  setPluginBypass(instanceId: string, on: boolean): void {
    for (const s of this.samplers) if (s instanceof WasmInstrumentDsp && s.instanceId === instanceId) s.bypass = on;
    for (const c of this.channels) for (const e of c.effects) if (e.dsp instanceof WasmEffectDsp && e.dsp.instanceId === instanceId) e.dsp.bypass = on;
  }

  private syncCounters() {
    let pf = 0;
    for (const s of this.samplers) if (s instanceof WasmInstrumentDsp && s.fault) pf++;
    for (const c of this.channels) for (const e of c.effects) if (e.dsp instanceof WasmEffectDsp && e.dsp.fault) pf++;
    this.counters.pluginFaults = pf;
    let st = 0, af = 0, ms = 0;
    for (const s of this.samplers) if (s) { st += s.counters.voiceSteals; af += s.counters.articulationFallbacks; ms += s.counters.missingSamples; }
    this.counters.voiceSteals = st; this.counters.articulationFallbacks = af; this.counters.missingSamples = ms;
  }

  private renderInstruments(start: number, end: number): void {
    for (let t = 0; t < this.samplers.length; t++) {
      const s = this.samplers[t]; if (!s) continue;
      const inst = this.graph.tracks[t].instrument!;
      let g: Float32Array | null = null;
      if (inst.gainAutomation) { g = this.instGain; fillAutomation(inst.gainAutomation, this.timelineFrame, g, end, start); }
      else if (inst.gain !== 1) { g = this.instGain; g.fill(inst.gain, start, end); }
      s.render(this.trackBuf[t], start, end, g);
    }
  }

  private renderClip(c: GraphPlan['tracks'][number]['audioClips'][number], buf: Float32Array[], B: number): void {
    const t0 = this.timelineFrame;
    const s = Math.max(t0, c.startFrame), e = Math.min(t0 + B, c.startFrame + c.count);
    if (s >= e) return;
    const p = this.pcm.get(c.assetHash); if (!p) return;
    const L = p.channels[0], R = p.channels[1] ?? p.channels[0];
    for (let f = s; f < e; f++) {
      const k = f - c.startFrame; const src = c.srcStart + k;
      if (src >= L.length) break;
      let g = c.gain;
      if (k < c.fadeIn) g *= k / c.fadeIn;
      const fromEnd = c.count - k;
      if (fromEnd <= c.fadeOut) g *= (fromEnd - 1) / c.fadeOut;
      buf[0][f - t0] += L[src] * g; buf[1][f - t0] += R[src] * g;
    }
  }

  private fillParam(e: EffectNode, B: number): void {
    for (let k = 0; k < e.params.length; k++) {
      const a = e.rt.automation[k]; const arr = e.params[k];
      if (a) fillAutomation(a, this.timelineFrame, arr, B);
      else arr.fill(e.rt.values[k], 0, B);
    }
  }

  private fillChannelParam(a: AutomationRt | null, cur: number, target: number, buf: Float32Array, B: number): number {
    if (a) { fillAutomation(a, this.timelineFrame, buf, B); return buf[B - 1]; }
    // 수동 변경: 5ms 선형 smoothing (자동화와 중복 적용하지 않음)
    const step = Math.abs(target - cur) / Math.max(1, this.fadeLen);
    for (let i = 0; i < B; i++) { if (cur < target) cur = Math.min(target, cur + step); else if (cur > target) cur = Math.max(target, cur - step); buf[i] = cur; }
    return cur;
  }

  private processChannel(ci: number, B: number): void {
    const c = this.channels[ci]; const rt = this.graph.channels[ci];
    const io = c.buf;
    // insert effects
    for (const e of c.effects) {
      if (!e.dsp) continue;
      if (e.faulted) { e.bypassDelay?.process(io, B); continue; }
      this.fillParam(e, B);
      e.dsp.process(io, B, e.params);
      if (!finite(io[0], B) || !finite(io[1], B)) {
        // NaN/Infinity: 인스턴스 출력 0 + fault, 이후 지연 보상된 dry bypass (03 §5)
        io[0].fill(0, 0, B); io[1].fill(0, 0, B);
        e.faulted = true; this.counters.faults++;
        e.bypassDelay = e.dsp.latencyFrames > 0 ? new DelayLine(e.dsp.latencyFrames) : null;
      }
    }
    if (!finite(io[0], B) || !finite(io[1], B)) { io[0].fill(0, 0, B); io[1].fill(0, 0, B); this.counters.faults++; }
    // pre-send tap 은 insert 후, gain/pan 전
    c.pre[0].set(io[0].subarray(0, B)); c.pre[1].set(io[1].subarray(0, B));
    c.gainCur = this.fillChannelParam(rt.gainAutomation, c.gainCur, c.gainTarget, c.gainBuf, B);
    c.panCur = this.fillChannelParam(rt.panAutomation, c.panCur, c.panTarget, c.panBuf, B);
    const L = io[0], R = io[1];
    if (rt.mono) {
      // mono constant-power (center = unity): θ=(pan+1)π/4, L=√2cosθ, R=√2sinθ. pan 이 block 내 일정하면 한 번만 계산.
      if (c.panBuf[0] === c.panBuf[B - 1] && !rt.panAutomation) {
        const th = (c.panBuf[0] + 1) * Math.PI / 4; const gl = Math.SQRT2 * Math.cos(th), gr = Math.SQRT2 * Math.sin(th);
        for (let i = 0; i < B; i++) { const g = c.gainBuf[i]; L[i] *= g * gl; R[i] *= g * gr; }
      } else for (let i = 0; i < B; i++) { const th = (c.panBuf[i] + 1) * Math.PI / 4; const g = c.gainBuf[i]; L[i] *= g * Math.SQRT2 * Math.cos(th); R[i] *= g * Math.SQRT2 * Math.sin(th); }
    } else {
      // stereo balance
      for (let i = 0; i < B; i++) { const p = c.panBuf[i]; const g = c.gainBuf[i]; L[i] *= g * (p > 0 ? 1 - p : 1); R[i] *= g * (p < 0 ? 1 + p : 1); }
    }
    if (ci === this.graph.masterIndex) {
      if (!rt.audible) { L.fill(0, 0, B); R.fill(0, 0, B); }
      const pk = c.peak; for (let i = 0; i < B; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk[0]) pk[0] = a; if (b > pk[1]) pk[1] = b; }
      return;
    }
    // mute 는 output 과 send 모두 차단, solo 는 plan 에서 audible 로 계산
    if (!rt.audible) return;
    const pk = c.peak; for (let i = 0; i < B; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk[0]) pk[0] = a; if (b > pk[1]) pk[1] = b; }
    for (let k = 0; k < rt.edges.length; k++) {
      const e = rt.edges[k]; const src = e.tap === 'pre' ? c.pre : io; const d = c.edgeDelays[k];
      const tgt = this.channels[e.target].buf;
      if (d) {
        const tmp = c.edgeTmp; tmp[0].set(src[0].subarray(0, B)); tmp[1].set(src[1].subarray(0, B));
        d.process(tmp, B);
        for (let i = 0; i < B; i++) { tgt[0][i] += tmp[0][i] * e.gain; tgt[1][i] += tmp[1][i] * e.gain; }
      } else for (let i = 0; i < B; i++) { tgt[0][i] += src[0][i] * e.gain; tgt[1][i] += src[1][i] * e.gain; }
    }
  }

  /** UI meter (30Hz 이하로 읽고 reset) */
  takePeaks(): { master: [number, number]; channels: [number, number][] } {
    const r = { master: [this.channels[this.graph.masterIndex].peak[0], this.channels[this.graph.masterIndex].peak[1]] as [number, number], channels: this.channels.map((c) => [c.peak[0], c.peak[1]] as [number, number]) };
    for (const c of this.channels) c.peak.fill(0);
    this.masterPeak.fill(0);
    return r;
  }
}

function finite(x: Float32Array, n: number): boolean {
  let s = 0; for (let i = 0; i < n; i++) s += x[i];
  return Number.isFinite(s);
}
