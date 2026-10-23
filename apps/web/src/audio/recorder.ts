// MVP-4 녹음: getUserMedia(dry) → capture Worklet → 5초 segment(OPFS staging) + IDB journal → 확정 시 원본 WAV 자산.
// 상태: idle→requesting→armed→recording→finalizing→committed, 실패 시 recoverable/error (01 §7).
import type { Asset, Id } from '@bass-daw/schemas';
import { uuid, nowIso, Sha256 } from '@bass-daw/schemas';
import { wavHeader } from '@bass-daw/audio-engine';
import { paths, type LocalStore } from '@bass-daw/storage';
import captureUrl from './capture-processor.ts?worker&url';
import { engine } from './engine.ts';

export type RecState = 'idle' | 'requesting' | 'armed' | 'recording' | 'finalizing' | 'committed' | 'recoverable' | 'error';
export interface Segment { path: string; frames: number; hash: string; n: number }
export interface Journal {
  id: string; projectId: Id; kind: 'recording'; state: 'recording' | 'finalizing' | 'recoverable' | 'committed';
  trackId: Id; sampleRate: number; channels: number; startSeconds: number; offsetFrames: number;
  segments: Segment[]; settings: Record<string, unknown>; createdAt: string; reason?: string;
}
export interface Calibration { roundTripFrames: number; sampleRate: number; inputId: string; outputLatency: number | null; at: string; spreadFrames: number; pulses: number[] }

const SEGMENT_SECONDS = 5;
let busy = false;
export const recorderBusy = () => busy;

export class Recorder {
  state: RecState = 'idle';
  error: string | null = null;
  stream: MediaStream | null = null;
  settings: MediaTrackSettings | null = null;
  devices: MediaDeviceInfo[] = [];
  deviceId = '';
  channels = 1;
  monitor = false;
  inputPeak = 0;
  manualOffsetMs = 0;
  calibration: Calibration | null = null;
  calibrationStale = false;
  journal: Journal | null = null;
  recordedFrames = 0;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private monGain: GainNode | null = null;
  private chunks: Float32Array[][] = []; private chunkFrames = 0; private segN = 0;
  private writing: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private startFrame = 0;
  private onDeviceChange = () => { void this.refreshDevices(); if (this.calibration && this.calibration.inputId !== this.deviceId) this.calibrationStale = true; this.emit(); };

  constructor(private store: LocalStore, private projectId: Id) {
    try { const c = localStorage.getItem('bass-daw:calibration'); if (c) this.calibration = JSON.parse(c); this.manualOffsetMs = Number(localStorage.getItem('bass-daw:manualOffsetMs') ?? 0); } catch { /* ignore */ }
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const l of this.listeners) l(); }
  private set(s: RecState, err: string | null = null) { this.state = s; this.error = err; busy = s === 'recording' || s === 'finalizing'; this.emit(); }

  async refreshDevices() {
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { this.devices = []; }
    this.emit();
  }

  /** 사용자 gesture 에서 호출. 권한 거부·장치 없음·장치 제거를 구분한다. */
  async arm(): Promise<void> {
    const ctx = engine.ctx;
    if (!ctx) return this.set('error', 'Start audio first (오디오 시작).');
    if (!navigator.mediaDevices?.getUserMedia) return this.set('error', 'getUserMedia unavailable (secure context required: HTTPS or localhost).');
    this.set('requesting');
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.deviceId ? { exact: this.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: this.channels } } });
    } catch (e) {
      const name = (e as DOMException).name;
      const msg = name === 'NotAllowedError' ? 'PERMISSION_DENIED: 마이크 권한이 거부되었습니다. 브라우저 사이트 설정에서 허용하세요.'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'NO_DEVICE: 사용할 수 있는 입력 장치가 없습니다.'
        : name === 'NotReadableError' ? 'DEVICE_BUSY: 장치를 다른 앱이 사용 중이거나 읽을 수 없습니다.' : `${name}: ${(e as Error).message}`;
      return this.set('error', msg);
    }
    const track = this.stream.getAudioTracks()[0];
    this.settings = track.getSettings();
    track.onended = () => {
      this.stream = null;
      if (this.state === 'recording') void this.stop('CAPTURE_LOST: input device removed or stopped');
      else this.set('error', 'CAPTURE_LOST: input device removed');
    };
    await this.refreshDevices();
    if (!this.deviceId && this.settings.deviceId) this.deviceId = this.settings.deviceId;
    if (this.calibration && this.calibration.inputId !== (this.settings.deviceId ?? '')) this.calibrationStale = true;
    await ctx.audioWorklet.addModule(captureUrl);
    this.node?.disconnect(); this.src?.disconnect();
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'bass-daw-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: Math.max(1, Math.min(2, this.channels)), channelCountMode: 'explicit' });
    this.src.connect(this.node);
    const sink = ctx.createGain(); sink.gain.value = 0; this.node.connect(sink).connect(ctx.destination);
    this.monGain = ctx.createGain(); this.monGain.gain.value = this.monitor ? 1 : 0; this.src.connect(this.monGain).connect(ctx.destination);
    this.node.port.onmessage = (e) => this.onCapture(e.data);
    this.set('armed');
  }

  setMonitor(on: boolean) { this.monitor = on; if (this.monGain) this.monGain.gain.value = on ? 1 : 0; this.emit(); }
  setManualOffset(ms: number) { this.manualOffsetMs = ms; try { localStorage.setItem('bass-daw:manualOffsetMs', String(ms)); } catch { /* ignore */ } this.emit(); }

  /**
   * 배치 offset: loopback 보정(장치 round-trip) + 그래프 PDC latency(출력이 그만큼 늦게 들림) + 사용자 보정.
   * 무보정 원본·capture origin 은 journal 에 보존하고 clip 배치만 바꾼다.
   */
  offsetFrames(sr: number): number {
    const cal = this.calibration && !this.calibrationStale && this.calibration.sampleRate === sr ? this.calibration.roundTripFrames : 0;
    return cal + engine.status.graphLatency + Math.round((this.manualOffsetMs / 1000) * sr);
  }

  private onCapture(m: { type: string; frame?: number; data?: Float32Array[]; peak?: number }) {
    if (m.type === 'meter') { this.inputPeak = m.peak ?? 0; this.emit(); return; }
    if (m.type === 'calib-pcm') return;
    if (this.calibrating) { if (m.type === 'pcm') this.calibrating.push(m.frame!, m.data!); else if (m.type === 'started') this.calibrating.started(m.frame!); return; }
    if (m.type === 'started' && this.journal) {
      this.startFrame = m.frame!;
      const ctx = engine.ctx!;
      const tf = engine.timelineFrameAtContextFrame(this.startFrame);
      this.journal.startSeconds = Math.max(0, tf / ctx.sampleRate);
      void this.store.putJournal(this.journal as never);
      this.set('recording');
    } else if (m.type === 'pcm' && this.journal) {
      this.chunks.push(m.data!); this.chunkFrames += m.data![0].length; this.recordedFrames += m.data![0].length;
      if (this.chunkFrames >= SEGMENT_SECONDS * this.journal.sampleRate) this.closeSegment();
      this.emit();
    } else if (m.type === 'stopped') {
      if (this.forcedStop) return; // 장치 제거 등으로 이미 강제 확정 중
      this.closeSegment();
      // A quota/IO stop preserves the recovery journal; its ack must not auto-commit it.
      void this.writing.then(() => this.journal?.state === 'recoverable' ? undefined : this.finalize());
    }
  }

  private closeSegment() {
    const j = this.journal; if (!j || this.chunkFrames === 0) return;
    const chunks = this.chunks; const frames = this.chunkFrames; const n = this.segN++;
    this.chunks = []; this.chunkFrames = 0;
    // interleaved float32 segment
    const data = new Float32Array(frames * j.channels);
    let o = 0;
    for (const c of chunks) for (let i = 0; i < c[0].length; i++) for (let ch = 0; ch < j.channels; ch++) data[o++] = c[Math.min(ch, c.length - 1)][i];
    const bytes = new Uint8Array(data.buffer);
    const path = paths.segment(j.id, n);
    this.store.activeStaging.add(path);
    this.writing = this.writing.then(async () => {
      try {
        const w = await this.store.bytes.write(path, bytes);
        j.segments.push({ path, frames, hash: w.hash, n });
        await this.store.putJournal(j as never); // 닫힌 segment 만 복구 대상
      } catch (e) {
        const quota = (e as DOMException)?.name === 'QuotaExceededError';
        j.state = 'recoverable'; j.reason = quota ? 'QUOTA during recording' : `segment write failed: ${(e as Error).message}`;
        await this.store.putJournal(j as never).catch(() => undefined);
        this.node?.port.postMessage({ type: 'stop' });
        this.set('recoverable', `${quota ? 'QUOTA' : 'IO'}: 녹음을 중단했습니다. 닫힌 segment ${j.segments.length}개와 기존 프로젝트는 보존되었습니다.`);
      }
    });
  }

  async record(trackId: Id): Promise<void> {
    if (this.state !== 'armed' && this.state !== 'committed') return;
    const ctx = engine.ctx!;
    const id = uuid();
    this.journal = { id, projectId: this.projectId, kind: 'recording', state: 'recording', trackId, sampleRate: ctx.sampleRate, channels: this.channels, startSeconds: 0, offsetFrames: this.offsetFrames(ctx.sampleRate), segments: [], settings: { ...(this.settings ?? {}), monitor: this.monitor, contextRate: ctx.sampleRate, inputRate: this.settings?.sampleRate ?? null, calibrationStale: this.calibrationStale }, createdAt: nowIso() };
    this.chunks = []; this.chunkFrames = 0; this.segN = 0; this.recordedFrames = 0;
    await this.store.putJournal(this.journal as never);
    if (engine.state !== 'playing') await engine.play();
    this.node!.port.postMessage({ type: 'start', channels: this.channels });
  }

  private forcedStop = false;
  private finalizingIds = new Set<string>();

  async stop(reason?: string): Promise<void> {
    if (this.state !== 'recording') return;
    this.set('finalizing');
    if (!reason) { this.node?.port.postMessage({ type: 'stop' }); return; } // 'stopped' ack 후 확정
    // 강제 중단(capture lost 등): worklet ack 를 기다리지 않고 닫힌 segment 로 확정
    this.forcedStop = true;
    if (this.journal) this.journal.reason = reason;
    this.node?.port.postMessage({ type: 'stop' });
    this.closeSegment(); await this.writing; await this.finalize();
    this.forcedStop = false;
    const st = this.state as RecState;
    this.set(st === 'recoverable' ? 'recoverable' : this.stream ? 'armed' : 'idle', `${reason} — 녹음을 중단하고 닫힌 segment 까지 저장했습니다.`);
  }

  /** 닫힌 segment → WAV(float32) 원본 자산 + 오디오 클립. 반환 명령은 호출자가 실행. */
  onCommit: ((asset: Asset, j: Journal) => boolean) | null = null;

  async finalize(j: Journal | null = this.journal): Promise<void> {
    if (!j || this.finalizingIds.has(j.id)) return; // 같은 journal 의 중복 확정 방지(클립 중복 금지)
    this.finalizingIds.add(j.id);
    try { await this.finalizeOnce(j); } finally { this.finalizingIds.delete(j.id); }
  }

  private async finalizeOnce(j: Journal): Promise<void> {
    if (this.state !== 'recoverable') this.set('finalizing');
    try {
      const frames = j.segments.reduce((s, x) => s + x.frames, 0);
      if (frames === 0) { j.state = 'committed'; await this.store.putJournal(j as never); this.set('armed'); return; }
      const parts: BlobPart[] = [wavHeader('wav-float32', j.channels, j.sampleRate, frames) as unknown as BlobPart];
      for (const s of [...j.segments].sort((a, b) => a.n - b.n)) {
        const b = await this.store.bytes.read(s.path);
        if (!b) throw new Error(`segment ${s.n} missing`);
        const h = new Sha256(); h.update(new Uint8Array(await b.arrayBuffer()));
        if (h.digestHex() !== s.hash) throw new Error(`segment ${s.n} hash mismatch`);
        parts.push(b);
      }
      const wav = new Blob(parts, { type: 'audio/wav' });
      const imp = await this.store.importAsset(wav);
      if (!imp.ok) throw new Error(`${imp.errors[0].code}: ${imp.errors[0].message}`);
      const asset: Asset = { id: uuid(), sha256: imp.value.hash, byteLength: imp.value.bytes, mediaType: 'audio/wav', audio: { sampleRate: j.sampleRate, channels: j.channels, frameCount: frames }, license: { name: 'user recording', origin: `recorded ${j.createdAt}`, redistribution: 'allowed' } };
      j.state = 'finalizing'; await this.store.putJournal({ ...j, assetHashes: [asset.sha256] } as never);
      if (!this.onCommit?.(asset, j)) throw new Error('could not place clip (project edit failed)');
      j.state = 'committed'; await this.store.putJournal({ ...j, assetHashes: [asset.sha256] } as never);
      for (const s of j.segments) { this.store.activeStaging.delete(s.path); await this.store.bytes.remove(s.path); }
      await this.store.deleteJournal(j.id);
      this.journal = null;
      this.set(this.stream ? 'armed' : 'committed');
    } catch (e) {
      j.state = 'recoverable'; j.reason = (e as Error).message;
      await this.store.putJournal(j as never).catch(() => undefined);
      this.set('recoverable', `녹음 확정 실패: ${(e as Error).message}. 닫힌 segment 는 보존되어 복구할 수 있습니다.`);
    }
  }

  async pendingJournals(): Promise<Journal[]> {
    return (await this.store.journals(this.projectId)).filter((j) => j.kind === 'recording' && j.state !== 'committed') as unknown as Journal[];
  }

  async discard(j: Journal) { for (const s of j.segments) await this.store.bytes.remove(s.path); await this.store.deleteJournal(j.id); this.emit(); }

  disarm() {
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.node?.disconnect(); this.src?.disconnect(); this.monGain?.disconnect();
    this.node = null; this.src = null;
    if (this.state !== 'recording') this.set('idle');
  }

  // ---------------- 유선 loopback 보정 (01 §7, R04) ----------------
  private calibrating: { push(frame: number, d: Float32Array[]): void; started(frame: number): void } | null = null;
  /** 출력→입력을 케이블로 연결한 상태에서 10개 pulse 의 round-trip 중앙값. 추정 baseLatency 를 정답으로 쓰지 않는다. */
  async calibrate(pulses = 10): Promise<Calibration> {
    const ctx = engine.ctx!;
    if (this.state !== 'armed') throw new Error('arm the input first');
    const sr = ctx.sampleRate;
    const interval = 0.5;
    const pcm: { frame: number; data: Float32Array }[] = [];
    let startedAt = 0;
    const done = new Promise<void>((res) => {
      this.calibrating = { push: (f, d) => { pcm.push({ frame: f, data: d[0] }); if (f > startedAt + (pulses + 1.5) * interval * sr) res(); }, started: (f) => { startedAt = f; } };
    });
    this.node!.port.postMessage({ type: 'start', channels: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = ctx.currentTime + 0.3;
    const click = ctx.createBuffer(1, 48, sr); click.getChannelData(0).fill(0.9, 0, 8);
    const sched: number[] = [];
    for (let i = 0; i < pulses; i++) { const s = ctx.createBufferSource(); s.buffer = click; s.connect(ctx.destination); const when = t0 + i * interval; s.start(when); sched.push(Math.round(when * sr)); }
    await Promise.race([done, new Promise((r) => setTimeout(r, (pulses * interval + 4) * 1000))]);
    this.node!.port.postMessage({ type: 'stop' });
    this.calibrating = null;
    // onset 검출
    const all = pcm.sort((a, b) => a.frame - b.frame);
    let noise = 0; let cnt = 0;
    for (const c of all) for (let i = 0; i < c.data.length; i++) if (c.frame + i < sched[0]) { noise = Math.max(noise, Math.abs(c.data[i])); cnt++; }
    const thr = Math.max(0.05, noise * 4);
    const rts: number[] = [];
    for (const s of sched) {
      let found = -1;
      for (const c of all) { for (let i = 0; i < c.data.length; i++) { const f = c.frame + i; if (f >= s && f < s + interval * sr * 0.9 && Math.abs(c.data[i]) > thr) { found = f; break; } } if (found >= 0) break; }
      if (found >= 0) rts.push(found - s);
    }
    void cnt;
    if (rts.length < Math.ceil(pulses * 0.7)) throw new Error(`loopback pulses detected ${rts.length}/${pulses} — check the cable and input level (BLOCKED without loopback)`);
    const sorted = [...rts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cal: Calibration = { roundTripFrames: median, sampleRate: sr, inputId: this.settings?.deviceId ?? '', outputLatency: (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? null, at: nowIso(), spreadFrames: sorted.at(-1)! - sorted[0], pulses: rts };
    this.calibration = cal; this.calibrationStale = false;
    try { localStorage.setItem('bass-daw:calibration', JSON.stringify(cal)); } catch { /* ignore */ }
    this.emit();
    return cal;
  }
}
