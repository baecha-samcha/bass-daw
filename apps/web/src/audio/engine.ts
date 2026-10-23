// 메인 스레드 AudioEngine (01 §4 공개 API). UI/Zustand 는 이 객체만 호출한다.
import type { Project, Result, Tick, PluginManifest } from '@bass-daw/schemas';
import { TempoMap } from '@bass-daw/music-core';
import {
  compilePlan, EngineStateMachine, createRingBuffer, POLYPHONY, PCM_BUDGET_BYTES, estimatePcmBytes,
  type EngineState, type Profile, type GraphPlan, type EventTable, type RuntimeNotice, type CoreCounters, type RuntimeStatus, type Pcm, type CompileRecord,
} from '@bass-daw/audio-engine';
import processorUrl from './processor.ts?worker&url';
import { getPcm, dropPcm, type AssetLoader } from './pcm-cache.ts';

export interface EngineStatus {
  state: EngineState; tick: number; contextFrame: number; generation: number; sampleRate: number;
  requestedSampleRate: number; diagnostics: string[]; counters: CoreCounters | null; runtime: RuntimeStatus | null;
  activeVoices: number; blockMsMax: number; baseLatency: number | null; outputLatency: number | null;
  transport: 'sab' | 'messageport' | null; pcmBytes: number; profile: Profile; graphLatency: number;
  pluginFaults: { instanceId: string; reason: string }[];
  /** worklet 의 WASM 컴파일 기록(준비 단계에서만, transport=idle) */
  wasmCompiles: CompileRecord[];
}
interface WasmPrepared { id: number; transport: string; compiled: string[]; refused: string[]; failed: [string, string][]; log: CompileRecord[] }
type Listener = (s: EngineStatus) => void;

const ACK_TIMEOUT_MS = 2000;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private sm = new EngineStateMachine();
  private generation = 0;
  private planVersion = 0;
  private voiceIds = new Map<string, number>();
  private graph: GraphPlan | null = null;
  private table: EventTable | null = null;
  private tm: TempoMap | null = null;
  private project: Project | null = null;
  private loaded = new Set<string>();
  private pendingAcks = new Map<number, { resolve: (n: RuntimeNotice) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private meterListeners = new Set<(p: { master: [number, number]; channels: [number, number][] }) => void>();
  private lastStatusAt = 0; private lastTimeline = 0; private lastStatusCtxTime = 0;
  private graphSig = '';
  private preparedWasm = new Set<string>();
  private wasmReq = 0;
  private wasmWaiters = new Map<number, (r: WasmPrepared) => void>();
  private ring: SharedArrayBuffer | null = null; private statusSab: SharedArrayBuffer | null = null;
  profile: Profile = 'balanced';
  status: EngineStatus = {
    state: 'uninitialized', tick: 0, contextFrame: 0, generation: 0, sampleRate: 0, requestedSampleRate: 48000, diagnostics: [], counters: null, runtime: null,
    activeVoices: 0, blockMsMax: 0, baseLatency: null, outputLatency: null, transport: null, pcmBytes: 0, profile: 'balanced', graphLatency: 0, pluginFaults: [], wasmCompiles: [],
  };
  loadAsset: AssetLoader = async () => null;
  /** 설치된 외부 플러그인 조회(정확한 version + 고정 hash). 없으면 PLUGIN_MISSING */
  pluginResolver: ((pluginId: string, version: string, pinnedHash: string | null) => Promise<{ record: { key: string; manifest: PluginManifest; memoryPages: number; bundleHash: string }; module: WebAssembly.Module; dsp: Uint8Array } | null>) | null = null;
  /** 현재 프로젝트의 외부 플러그인 조회 결과(export 등에서 재사용) */
  resolvedPlugins = new Map<string, { key: string; manifest: PluginManifest; memoryPages: number; bundleHash: string; module: WebAssembly.Module; dsp: Uint8Array }>();

  async resolvePlugins(project: Project) {
    const out = new Map<string, { key: string; manifest: PluginManifest; memoryPages: number; bundleHash: string; module: WebAssembly.Module; dsp: Uint8Array }>();
    for (const pl of project.plugins) {
      if (pl.pluginId.startsWith('builtin.') || !this.pluginResolver) continue;
      const key = `${pl.pluginId}@${pl.pluginVersion}`;
      if (out.has(key)) continue;
      const r = await this.pluginResolver(pl.pluginId, pl.pluginVersion, project.metadata[`pluginHash:${key}`] ?? null);
      if (r) out.set(key, { ...r.record, module: r.module, dsp: r.dsp });
    }
    return out;
  }
  /**
   * 준비 단계: 검증된 WASM 바이트를 worklet 에 보내 컴파일시킨다. worklet 은 transport 가 idle 일 때만 컴파일한다.
   * prepare() 는 재생 중 그래프 변경이면 먼저 pause ack 를 받은 뒤 이 단계를 거친다.
   */
  async prepareWasm(entries: [string, Uint8Array][], keep: string[]): Promise<WasmPrepared | null> {
    if (!this.node) return null;
    const id = ++this.wasmReq;
    const done = new Promise<WasmPrepared | null>((res) => { const t = setTimeout(() => { this.wasmWaiters.delete(id); res(null); }, 10_000); this.wasmWaiters.set(id, (r) => { clearTimeout(t); res(r); }); });
    this.node.port.postMessage({ type: 'prepareWasm', id, wasm: entries, keep });
    const r = await done;
    if (!r) { this.diag('WASM_PREPARE_TIMEOUT'); return null; }
    for (const k of r.compiled) this.preparedWasm.add(k);
    for (const k of r.refused) this.diag(`WASM_COMPILE_REFUSED ${k}: transport ${r.transport} (compile only in the prepare phase)`);
    for (const [k, why] of r.failed) this.diag(`WASM_COMPILE_FAILED ${k}: ${why}`);
    for (const k of [...this.preparedWasm]) if (!keep.includes(k)) this.preparedWasm.delete(k);
    return r;
  }
  bypassPlugin(instanceId: string, on: boolean) { this.node?.port.postMessage({ type: 'bypass', instanceId, on }); }
  /** 진단: processorerror 유발 → node 재생성 경로 확인(P03) */
  injectProcessorError() { this.node?.port.postMessage({ type: 'crash' }); }
  /** 재생 시작 위치(정지 시 복귀) */
  private startTick = 0;

  subscribe(fn: Listener) { this.listeners.add(fn); fn(this.status); return () => { this.listeners.delete(fn); }; }
  onMeters(fn: (p: { master: [number, number]; channels: [number, number][] }) => void) { this.meterListeners.add(fn); return () => { this.meterListeners.delete(fn); }; }
  private emit(patch: Partial<EngineStatus>) { this.status = { ...this.status, ...patch, state: this.sm.state }; for (const l of this.listeners) l(this.status); }
  private diag(msg: string) { this.emit({ diagnostics: [...this.status.diagnostics.slice(-30), `${new Date().toISOString().slice(11, 19)} ${msg}`] }); }

  get state(): EngineState { return this.sm.state; }

  /** 사용자 gesture 안에서 호출해야 한다. */
  async initialize(options: { requestedSampleRate: 48000; profile: Profile }): Promise<Result<EngineStatus>> {
    if (this.sm.state !== 'uninitialized' && this.sm.state !== 'error') return { ok: true, value: this.status };
    try {
      const fromError = this.sm.state === 'error';
      if (fromError) { this.sm.to('recovering'); this.sm.to('paused'); } else this.sm.to('preparing');
      this.profile = options.profile;
      let ctx: AudioContext;
      try { ctx = new AudioContext({ sampleRate: options.requestedSampleRate, latencyHint: 'interactive' }); }
      catch { ctx = new AudioContext({ latencyHint: 'interactive' }); this.diag('48kHz context refused; using device rate'); }
      this.ctx = ctx;
      await ctx.resume();
      await ctx.audioWorklet.addModule(processorUrl);
      ctx.onstatechange = () => this.onContextState();
      await this.createNode();
      if (!fromError) this.sm.to('ready');
      this.emit({ sampleRate: ctx.sampleRate, requestedSampleRate: options.requestedSampleRate, baseLatency: ctx.baseLatency ?? null, outputLatency: (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? null, profile: options.profile });
      return { ok: true, value: this.status };
    } catch (e) {
      if (this.sm.can('error')) this.sm.to('error');
      this.diag(`initialize failed: ${(e as Error).message}`);
      return { ok: false, errors: [{ code: 'CONTEXT_FAILED', path: '$', message: (e as Error).message }] };
    }
  }

  private async createNode() {
    const ctx = this.ctx!;
    this.node?.disconnect(); this.worker?.terminate();
    this.loaded.clear(); this.preparedWasm.clear();
    const node = new AudioWorkletNode(ctx, 'bass-daw', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.onprocessorerror = () => { this.diag('DSP_FAULT: processorerror — node will be recreated'); void this.recover(); };
    node.port.onmessage = (e) => this.onWorklet(e.data);
    node.port.onmessageerror = () => this.diag('DSP_FAULT: worklet could not deserialize a message (non-cloneable payload)');
    this.node = node;
    const isolated = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated;
    this.ring = isolated ? (createRingBuffer(65536, true) as SharedArrayBuffer) : null;
    this.statusSab = isolated ? new SharedArrayBuffer(16) : null;
    this.worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' });
    const ch = new MessageChannel();
    this.worker.postMessage({ type: 'init', ring: this.ring, status: this.statusSab, sampleRate: ctx.sampleRate, lookahead: 0.25, period: 25, port: ch.port1 }, [ch.port1]);
    this.schedPort = ch.port2;
    this.emit({ transport: isolated ? 'sab' : 'messageport' });
  }
  private schedPort: MessagePort | null = null;
  private anchor: { cf: number; tf: number; op: string } | null = null;

  /** 녹음 배치용: context frame → timeline frame (재생 시작 anchor 기준, 루프 전개 없음) */
  timelineFrameAtContextFrame(cf: number): number {
    if (!this.anchor || this.anchor.op !== 'play') return this.lastTimeline;
    return this.anchor.tf + (cf - this.anchor.cf);
  }

  /** meter 배열 순서(엔진 그래프의 위상 정렬 순서) */
  channelOrder(): string[] { return this.graph?.channels.map((c) => c.id) ?? []; }

  /** 믹서 조작 미리보기(영속 값은 SetParameter 명령으로 확정) */
  previewChannel(channelId: string, param: 'gain' | 'pan', value: number) {
    const i = this.graph?.channels.findIndex((c) => c.id === channelId) ?? -1;
    if (i >= 0) this.node?.port.postMessage({ type: 'param', channelIndex: i, param, value });
  }
  previewEffect(channelId: string, instanceId: string, paramId: string, value: number) {
    const i = this.graph?.channels.findIndex((c) => c.id === channelId) ?? -1;
    if (i < 0) return;
    const k = this.graph!.channels[i].effects.findIndex((e) => e.instanceId === instanceId);
    const j = k >= 0 ? this.graph!.channels[i].effects[k].paramIds.indexOf(paramId) : -1;
    if (j >= 0) this.node?.port.postMessage({ type: 'effectParam', channelIndex: i, effectIndex: k, paramIndex: j, value });
  }

  private onContextState() {
    const st = this.ctx?.state as string;
    if ((st === 'suspended' || st === 'interrupted') && (this.sm.state === 'playing' || this.sm.state === 'paused' || this.sm.state === 'ready')) {
      const wasPlaying = this.sm.state === 'playing';
      this.sm.to('suspended'); this.diag(`CONTEXT_SUSPENDED (${st})${wasPlaying ? ' during playback' : ''}`);
      this.emit({});
    } else if (st === 'running' && this.sm.state === 'suspended') {
      // 복귀 시 이전 위치에서 paused, 사용자 재생을 기다린다
      this.sm.to('paused');
      void this.sendControl('pause', this.currentTimelineFrame());
    }
  }

  private onWorklet(m: { type: string; [k: string]: unknown }) {
    if (m.type === 'notice') {
      const n = m.notice as RuntimeNotice;
      if (n.type === 'ack') { const w = this.pendingAcks.get(n.generation); if (w) { clearTimeout(w.timer); this.pendingAcks.delete(n.generation); w.resolve(n); } }
      if (n.type === 'underrun') {
        this.diag('QUEUE_UNDERRUN — playback paused (main thread/worker could not keep up)');
        if (this.sm.state === 'playing') this.sm.to('paused');
        this.lastTimeline = n.timelineFrame; this.emit({});
      }
    } else if (m.type === 'status') {
      const rs = m.status as RuntimeStatus;
      this.lastTimeline = rs.timelineFrame; this.lastStatusAt = performance.now(); this.lastStatusCtxTime = this.ctx?.currentTime ?? 0;
      this.emit({ runtime: rs, counters: m.counters as CoreCounters, activeVoices: m.activeVoices as number, blockMsMax: m.blockMsMax as number, contextFrame: rs.contextFrame, pluginFaults: (m.faults as EngineStatus['pluginFaults']) ?? [] });
    } else if (m.type === 'wasmPrepared') {
      const r = m as unknown as WasmPrepared;
      this.emit({ wasmCompiles: r.log });
      this.wasmWaiters.get(r.id)?.(r); this.wasmWaiters.delete(r.id);
    } else if (m.type === 'error') {
      this.diag(`DSP_FAULT worklet ${String(m.op)}: ${String(m.message)}`);
    } else if (m.type === 'meters') {
      for (const l of this.meterListeners) l(m.peaks as never);
    }
  }

  private waitAck(generation: number): Promise<RuntimeNotice> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingAcks.delete(generation); reject(new Error('ACK_TIMEOUT')); }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(generation, { resolve, timer });
    });
  }

  private async sendControl(op: 'play' | 'pause' | 'stop' | 'seek', timelineFrame: number): Promise<boolean> {
    if (!this.node) return false;
    const generation = ++this.generation;
    const ack = this.waitAck(generation);
    this.node.port.postMessage({ type: 'control', op, generation, timelineFrame });
    try {
      const n = await ack;
      if (n.type === 'ack') this.anchor = { cf: n.anchorCf, tf: n.timelineFrame, op: n.op };
      this.emit({ generation }); return true;
    }
    catch {
      // ack 없이 성공으로 표시하지 않는다 — 엔진 정지/복구
      this.diag(`ACK timeout for ${op}; recovering`);
      await this.recover();
      return false;
    }
  }

  /** 오류 후 recovering: 그래프 재생성, 성공 시 paused, 실패 시 error */
  async recover(): Promise<void> {
    if (!this.ctx) return;
    try {
      if (this.sm.can('recovering')) this.sm.to('recovering'); else return;
      this.emit({});
      await this.createNode();
      if (this.project) await this.prepare(this.project, true);
      this.sm.to('paused'); this.emit({});
    } catch (e) {
      if (this.sm.can('error')) this.sm.to('error');
      this.diag(`recovery failed: ${(e as Error).message}`);
    }
  }

  private graphSignature(g: GraphPlan): string {
    // gain/pan 실시간 값과 audible 은 live 메시지로 전달하므로 signature 에서 제외
    return JSON.stringify({ ...g, graphRevision: 0, channels: g.channels.map((c) => ({ ...c, gain: 0, pan: 0, audible: true, effects: c.effects.map((e) => ({ ...e, values: [] })) })), endFrame: 0 });
  }

  /** 그래프·PCM·이벤트 준비. 정지 중 전체 준비, 재생 중에는 이벤트 표만 교체(짧은 재진입). */
  async prepare(project: Project, force = false): Promise<Result<{ graphRevision: number }>> {
    if (!this.ctx || !this.node) return { ok: false, errors: [{ code: 'CONTEXT_SUSPENDED', path: '$', message: 'engine not initialized' }] };
    const sr = this.ctx.sampleRate;
    this.project = project;
    // 필요한 자산 디코딩(PCM budget 검사 포함)
    const needed = new Map<string, string>();
    for (const a of project.assets) if (a.audio) needed.set(a.sha256, a.mediaType);
    const pcm = new Map<string, Pcm>();
    const missing: string[] = [];
    await Promise.all([...needed].map(async ([h, mt]) => { try { const p = await getPcm(h, sr, this.loadAsset, mt); if (p) pcm.set(h, p); else missing.push(h); } catch { missing.push(h); } }));
    const ext = await this.resolvePlugins(project);
    this.resolvedPlugins = ext;
    const plan = compilePlan(project, { sampleRate: sr, profile: this.profile, graphRevision: (this.graph?.graphRevision ?? 0) + 1, voiceIds: this.voiceIds, plugins: (id, v) => ext.get(`${id}@${v}`) ?? null, assetInfo: (h) => { const p = pcm.get(h); return p ? { sampleRate: p.sampleRate, channels: p.channels.length } : null; } });
    if (!plan.ok) { this.diag(`${plan.code}: ${plan.message}`); return { ok: false, errors: [{ code: plan.code, path: '$', message: plan.message }] }; }
    const pcmBytes = estimatePcmBytes(plan.graph, (h) => { const p = pcm.get(h); return p ? { frames: p.frames, channels: p.channels.length } : null; });
    if (pcmBytes > PCM_BUDGET_BYTES[this.profile]) this.diag(`MEMORY_BUDGET: decoded PCM ${(pcmBytes / 2 ** 20).toFixed(0)}MiB exceeds ${this.profile} budget ${(PCM_BUDGET_BYTES[this.profile] / 2 ** 20).toFixed(0)}MiB — consider freezing/bouncing tracks`);
    for (const d of plan.diagnostics) if (!this.status.diagnostics.some((x) => x.endsWith(d))) this.diag(d);
    this.tm = new TempoMap(project.tempoMap);
    const sig = this.graphSignature(plan.graph);
    const playing = this.sm.state === 'playing';
    const prevGraph = this.graph;
    this.graph = plan.graph; this.emit({ pcmBytes, graphLatency: plan.graph.totalLatency });
    const version = ++this.planVersion;
    if (!force && playing && sig === this.graphSig && prevGraph) {
      // 이벤트만 바뀜: worklet 에 표 전달 → 'plan' notice 후 scheduler 가 fedUntil 부터 새 표로 공급
      const kill = changedTracks(this.table, plan.events).map((ti) => plan.events.allOffBase + ti);
      this.table = plan.events;
      this.node.port.postMessage({ type: 'table', planVersion: version, table: plan.events });
      this.worker!.postMessage({ type: 'replace', planVersion: version, table: plan.events, loop: plan.graph.loop, kill });
      this.sendLive(plan.graph);
      return { ok: true, value: { graphRevision: plan.graph.graphRevision } };
    }
    const resumeAt = playing ? this.currentTimelineFrame() : null;
    if (playing) { await this.sendControl('pause', resumeAt!); this.sm.to('paused'); }
    const newPcm: [string, Float32Array[], number][] = [];
    for (const [h, p] of pcm) if (!this.loaded.has(h)) { newPcm.push([h, p.channels, p.sampleRate]); this.loaded.add(h); }
    const drop = [...this.loaded].filter((h) => !pcm.has(h));
    drop.forEach((h) => this.loaded.delete(h));
    dropPcm(new Set(pcm.keys()));
    const firstLoad = !this.graphSig;
    // transport 정지 상태(위에서 pause ack 확인)에서만 컴파일 단계를 거친다
    const needWasm = [...ext.values()].filter((x) => !this.preparedWasm.has(x.key)).map((x) => [x.key, x.dsp] as [string, Uint8Array]);
    if (needWasm.length || this.preparedWasm.size !== ext.size) await this.prepareWasm(needWasm, [...ext.values()].map((x) => x.key));
    this.node.port.postMessage({ type: 'load', graph: plan.graph, pcm: newPcm, drop, polyphony: POLYPHONY[this.profile], ring: this.ring, status: this.statusSab, leadFrames: Math.round(sr * 0.1), ...(firstLoad || force ? { schedPort: this.schedPort } : {}) }, firstLoad || force ? [this.schedPort!] : []);
    if (firstLoad || force) this.schedPort = null;
    this.table = plan.events;
    this.node.port.postMessage({ type: 'table', planVersion: version, table: plan.events });
    this.worker!.postMessage({ type: 'table', planVersion: version, table: plan.events, loop: plan.graph.loop });
    this.graphSig = sig;
    if (resumeAt !== null) { await this.play(undefined, resumeAt); }
    return { ok: true, value: { graphRevision: plan.graph.graphRevision } };
  }

  /** gain/pan/mute/solo/effect 값의 실시간 반영 (5ms smoothing 은 엔진에서) */
  private sendLive(g: GraphPlan) {
    if (!this.node) return;
    g.channels.forEach((c, i) => {
      this.node!.port.postMessage({ type: 'param', channelIndex: i, param: 'gain', value: c.gain });
      this.node!.port.postMessage({ type: 'param', channelIndex: i, param: 'pan', value: c.pan });
      c.effects.forEach((e, k) => e.values.forEach((v, j) => this.node!.port.postMessage({ type: 'effectParam', channelIndex: i, effectIndex: k, paramIndex: j, value: v })));
    });
    this.node.port.postMessage({ type: 'audible', flags: g.channels.map((c) => c.audible) });
  }

  currentTimelineFrame(): number {
    if (this.sm.state !== 'playing' || !this.ctx) return this.lastTimeline;
    return this.lastTimeline + Math.max(0, (this.ctx.currentTime - this.lastStatusCtxTime)) * this.ctx.sampleRate;
  }

  /** UI 표시용 현재 Tick (실수) */
  currentTick(): number {
    if (!this.tm || !this.ctx) return this.startTick;
    let f = this.currentTimelineFrame();
    if (this.sm.state === 'playing' && this.graph?.loop.enabled && f >= this.graph.loop.endFrame) {
      const len = this.graph.loop.endFrame - this.graph.loop.startFrame;
      f = this.graph.loop.startFrame + ((f - this.graph.loop.startFrame) % len);
    }
    return this.tm.secondsToTick(f / this.ctx.sampleRate);
  }

  async play(startTick?: Tick, startFrame?: number): Promise<Result<EngineStatus>> {
    if (!this.ctx || !this.tm) return { ok: false, errors: [{ code: 'ASSET_NOT_READY', path: '$', message: 'prepare first' }] };
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignore */ } }
    if (this.sm.state === 'suspended') this.sm.to('paused');
    const frame = startFrame ?? this.tm.tickToFrame(startTick ?? this.startTick, this.ctx.sampleRate);
    if (startTick !== undefined) this.startTick = startTick;
    const ok = await this.sendControl('play', frame);
    if (ok) { this.lastTimeline = frame; this.lastStatusCtxTime = this.ctx.currentTime + 0.1; this.sm.to('playing'); this.emit({}); }
    return { ok: true, value: this.status };
  }

  async pause(): Promise<Result<EngineStatus>> {
    if (this.sm.state !== 'playing') return { ok: true, value: this.status };
    const f = this.currentTimelineFrame();
    await this.sendControl('pause', f);
    this.lastTimeline = f;
    if (this.tm && this.ctx) this.startTick = Math.round(this.tm.secondsToTick(f / this.ctx.sampleRate));
    this.sm.to('paused'); this.emit({});
    return { ok: true, value: this.status };
  }

  /** stop: ready 상태, loop start(비활성이면 0) 로 이동 */
  async stop(): Promise<Result<EngineStatus>> {
    if (!this.ctx || !this.tm) return { ok: true, value: this.status };
    const loopStart = this.project?.loop.enabled ? this.project.loop.startTick : 0;
    const f = this.tm.tickToFrame(loopStart, this.ctx.sampleRate);
    await this.sendControl('stop', f);
    this.lastTimeline = f; this.startTick = loopStart;
    if (this.sm.state === 'playing' || this.sm.state === 'paused') this.sm.to('ready');
    this.emit({});
    return { ok: true, value: this.status };
  }

  /** seek: generation 증가·큐 폐기·voice/tail reset, 이전 playing 여부 유지 */
  async seek(tick: Tick): Promise<Result<EngineStatus>> {
    this.startTick = Math.max(0, Math.round(tick));
    if (!this.ctx || !this.tm) return { ok: true, value: this.status };
    const f = this.tm.tickToFrame(this.startTick, this.ctx.sampleRate);
    if (this.sm.state === 'playing') { await this.sendControl('play', f); this.lastTimeline = f; this.lastStatusCtxTime = this.ctx.currentTime + 0.1; }
    else { await this.sendControl('seek', f); this.lastTimeline = f; }
    this.emit({ tick: this.startTick });
    return { ok: true, value: this.status };
  }

  panic(): void { this.node?.port.postMessage({ type: 'panic' }); }

  async close(): Promise<void> {
    this.node?.disconnect(); this.worker?.terminate();
    await this.ctx?.close();
    this.node = null; this.worker = null; this.ctx = null;
    if (this.sm.can('closed')) this.sm.to('closed');
    this.emit({});
  }

  async suspendForTest(): Promise<void> { await this.ctx?.suspend(); }

  /** 진단: 큐 공급 worker 통계 */
  schedulerStats(): Promise<unknown> {
    return new Promise((res) => { const w = this.worker; if (!w) return res(null); const h = (e: MessageEvent) => { if (e.data.type === 'stats') { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); w.postMessage({ type: 'stats' }); });
  }
}

function changedTracks(a: EventTable | null, b: EventTable): number[] {
  const tracks = new Set<number>();
  if (!a) return [];
  const sig = (t: EventTable) => { const m = new Map<number, string[]>(); for (let i = 0; i < t.count; i++) { const k = t.track[i]; if (!m.has(k)) m.set(k, []); m.get(k)!.push(`${t.frame[i]}:${t.kind[i]}:${t.voice[i]}:${t.a[i]}:${t.b[i]}`); } return m; };
  const sa = sig(a), sb = sig(b);
  for (const k of new Set([...sa.keys(), ...sb.keys()])) if ((sa.get(k) ?? []).join() !== (sb.get(k) ?? []).join()) tracks.add(k);
  return [...tracks];
}

export const engine = new AudioEngine();
