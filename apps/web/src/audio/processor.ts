// AudioWorkletProcessor glue: RenderCore + WorkletRuntime 을 감싸기만 한다.
// process() 에서 동적 대량 할당·fetch·파일·JSON parse·log·await 를 하지 않는다(01 §9).
import { RenderCore, WorkletRuntime, RingConsumer, WasmModuleCache, decodeBatch, SLOT_WATERMARK, type GraphPlan, type EventTable, type Pcm, type Slot } from '@bass-daw/audio-engine';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown) }

type InMsg =
  | { type: 'prepareWasm'; id: number; wasm: [string, Uint8Array][]; keep: string[] }
  | { type: 'load'; graph: GraphPlan; pcm: [string, Float32Array[], number][]; drop: string[]; polyphony: number; ring: SharedArrayBuffer | null; status: SharedArrayBuffer | null; leadFrames: number; schedPort?: MessagePort }
  | { type: 'table'; planVersion: number; table: EventTable }
  | { type: 'control'; op: 'play' | 'pause' | 'stop' | 'seek'; generation: number; timelineFrame: number }
  | { type: 'param'; channelIndex: number; param: 'gain' | 'pan'; value: number }
  | { type: 'effectParam'; channelIndex: number; effectIndex: number; paramIndex: number; value: number }
  | { type: 'audible'; flags: boolean[] }
  | { type: 'panic' }
  | { type: 'bypass'; instanceId: string; on: boolean }
  | { type: 'crash' };

class BassDawProcessor extends AudioWorkletProcessor {
  private rt: WorkletRuntime | null = null;
  private pcm = new Map<string, Pcm>();
  private ring: RingConsumer | null = null;
  private status: Float64Array | null = null;
  private batch: Slot[] = []; private batchPos = 0;
  private schedPort: MessagePort | null = null;
  private lastStatus = 0; private lastMeter = 0;
  private blockTimes = new Float32Array(256); private bt = 0;
  private alive = true;
  private crash = false;
  private wasm = new WasmModuleCache();

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      try { this.onMessage(e.data); }
      catch (err) { this.port.postMessage({ type: 'error', op: e.data?.type, message: String((err as Error)?.message ?? err) }); }
    };
    this.port.onmessageerror = () => this.port.postMessage({ type: 'error', op: 'messageerror', message: 'message could not be deserialized in AudioWorkletGlobalScope' });
  }

  private onMessage(m: InMsg) {
    switch (m.type) {
      case 'load': {
        for (const h of m.drop) this.pcm.delete(h);
        for (const [h, chans, rate] of m.pcm) this.pcm.set(h, { sampleRate: rate, channels: chans, frames: chans[0].length });
        // load 는 컴파일하지 않는다: prepareWasm 단계에서 준비된 모듈만 쓴다(없으면 not-prepared bypass)
        const core = new RenderCore(m.graph, this.pcm, { maxBlock: 4096, polyphony: m.polyphony, wasm: this.wasm.modules });
        const prev = this.rt;
        this.rt = new WorkletRuntime(core, m.leadFrames);
        if (prev) { this.rt.contextFrame = prev.contextFrame; for (const [k, v] of prev.tables) this.rt.tables.set(k, v); }
        this.ring = m.ring ? new RingConsumer(m.ring) : null;
        this.status = m.status ? new Float64Array(m.status) : null;
        if (m.schedPort) { this.schedPort = m.schedPort; this.schedPort.onmessage = (e) => { if (e.data?.type === 'slots') { this.batch.push(...decodeBatch(e.data.buffer)); if (e.data.watermark) this.rt?.watermark(e.data.watermark.generation, e.data.watermark.frame); } }; }
        this.port.postMessage({ type: 'loaded', graphRevision: m.graph.graphRevision, contextFrame: this.rt.contextFrame });
        break;
      }
      case 'prepareWasm': {
        // Chrome 은 WebAssembly.Module 을 AudioWorklet 포트로 전달하지 않으므로 검증된 바이트를 받아 컴파일한다.
        // 준비 단계 전용: transport 가 idle 이 아니면(재생/시작 중) 컴파일을 거절한다.
        const transport = this.rt?.state ?? 'idle';
        this.wasm.retain(m.keep);
        const r = this.wasm.prepare(m.wasm, transport);
        this.port.postMessage({ type: 'wasmPrepared', id: m.id, transport, ...r, log: this.wasm.log.slice(-16) });
        break;
      }
      case 'table': this.rt?.setTable(m.planVersion, m.table); break;
      case 'control': this.rt?.control(m.op, m.generation, m.timelineFrame); this.batch.length = 0; this.batchPos = 0; break;
      case 'param': this.rt?.core.setChannelParam(m.channelIndex, m.param, m.value); break;
      case 'effectParam': this.rt?.core.setEffectParam(m.channelIndex, m.effectIndex, m.paramIndex, m.value); break;
      case 'audible': m.flags.forEach((f, i) => this.rt?.core.setAudible(i, f)); break;
      case 'panic': this.rt?.core.panic(); break;
      case 'bypass': this.rt?.core.setPluginBypass(m.instanceId, m.on); break;
      case 'crash': this.crash = true; break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (this.crash) throw new Error('diagnostic processorerror');
    if (!this.rt || !out || out.length < 2) { if (out) for (const c of out) c.fill(0); return this.alive; }
    const frames = out[0].length; // 실제 render quantum 길이 사용
    const t0 = Date.now();
    const rt = this.rt;
    if (this.ring) {
      const r = this.ring;
      rt.watermark(r.watermarkGeneration(), r.watermarkFrame(rt.contextFrame));
      rt.process(out, frames, () => r.peekFrame(), (s) => r.pop(s));
      if (this.status) { this.status[0] = rt.contextFrame; this.status[1] = rt.generation; }
    } else {
      rt.process(out, frames, () => {
        while (this.batchPos < this.batch.length && this.batch[this.batchPos].type === SLOT_WATERMARK) { const w = this.batch[this.batchPos++]; rt.watermark(w.generation, w.frame); }
        return this.batchPos < this.batch.length ? this.batch[this.batchPos].frame : Infinity;
      }, (s) => {
        if (this.batchPos >= this.batch.length) return false;
        const x = this.batch[this.batchPos++]; s.type = x.type; s.generation = x.generation; s.sequence = x.sequence; s.payloadIndex = x.payloadIndex; s.frame = x.frame;
        if (this.batchPos > 4096) { this.batch.splice(0, this.batchPos); this.batchPos = 0; }
        return true;
      });
    }
    this.blockTimes[this.bt++ & 255] = Date.now() - t0;
    if (rt.notices.length) {
      for (const n of rt.notices) { this.port.postMessage({ type: 'notice', notice: n }); this.schedPort?.postMessage({ type: 'notice', notice: n }); }
      rt.notices.length = 0;
    }
    if (!this.ring && this.schedPort && rt.state !== 'idle' && (rt.contextFrame / frames) % 8 === 0) this.schedPort.postMessage({ type: 'clock', contextFrame: rt.contextFrame });
    // 진단 ≤10Hz, meter ≤30Hz
    if (rt.contextFrame - this.lastStatus >= sampleRate / 10) {
      this.lastStatus = rt.contextFrame;
      const c = rt.core.counters;
      this.port.postMessage({ type: 'status', status: rt.status(), counters: { ...c }, activeVoices: rt.core.activeVoices, blockMsMax: Math.max(...this.blockTimes), currentFrame, faults: rt.core.counters.pluginFaults ? rt.core.pluginFaults() : [] });
    }
    if (rt.contextFrame - this.lastMeter >= sampleRate / 30) { this.lastMeter = rt.contextFrame; this.port.postMessage({ type: 'meters', peaks: rt.core.takePeaks() }); }
    return this.alive;
  }
}

registerProcessor('bass-daw', BassDawProcessor);
