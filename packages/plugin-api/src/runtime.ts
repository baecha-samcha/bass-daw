// ABI 1 런타임 호스트(03 §3). Worklet·Worker·Node 에서 동일하게 동작한다(TextEncoder 등 비의존).
// process 경로: 이벤트/파라미터 기록 → output clear → process → 메모리 크기·finite 검사. 할당 없음.
import type { PluginManifest } from '@bass-daw/schemas';
import { HOST_IMPORTS, ABI1_VERSION } from './wasm-binary.ts';

export const EV_SIZE = 32;
export const MAX_EVENTS_PER_SUBBLOCK = 1024;

export type FaultReason = 'trap' | 'nan' | 'negative-return' | 'memory-growth' | 'bad-pointer' | 'event-overflow';
export interface PluginEvent { offset: number; type: number; voice: number; channel: number; d0: number; d1: number; d2: number }
export interface SampleBinding { channels: Float32Array[]; sampleRate: number }

interface Exports {
  memory: WebAssembly.Memory;
  abi_version(): number; create(sr: number, max: number): number; alloc(n: number): number; free(p: number): void;
  configure(h: number, p: number, n: number): number; bind_sample(h: number, slot: number, p: number, ch: number, frames: number, sr: number): number;
  input_ptr(h: number, c: number): number; output_ptr(h: number, c: number): number; events_ptr(h: number): number; params_ptr(h: number): number;
  process(h: number, frames: number, ev: number): number; reset(h: number): number; destroy(h: number): void;
}

export class PluginPrepareError extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`); } }

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export class WasmPluginRuntime {
  readonly manifest: PluginManifest;
  readonly maxFrames: number;
  private ex: Exports;
  private handle = 0;
  private bytes = 0;
  private f32!: Float32Array; private u32!: Uint32Array;
  private inPtr: number[] = []; private outPtr: number[] = []; private evPtr = 0; private parPtr = 0;
  faulted: FaultReason | null = null;
  tailEnded = false;

  constructor(module: WebAssembly.Module, manifest: PluginManifest, readonly sampleRate: number, memoryPages: number) {
    this.manifest = manifest;
    this.maxFrames = manifest.maxBlockFrames;
    const host: Record<string, (...a: number[]) => number> = {};
    for (const [k, v] of Object.entries(HOST_IMPORTS)) host[k] = v.fn;
    const inst = new WebAssembly.Instance(module, { host });
    this.ex = inst.exports as unknown as Exports;
    // 시작 전 최대 메모리 확정: max 까지 미리 grow → 재생 중 memory.grow 는 항상 실패
    const cur = this.ex.memory.buffer.byteLength / 65536;
    if (memoryPages > cur) this.ex.memory.grow(memoryPages - cur);
    this.refreshViews();
  }

  private refreshViews() { this.bytes = this.ex.memory.buffer.byteLength; this.f32 = new Float32Array(this.ex.memory.buffer); this.u32 = new Uint32Array(this.ex.memory.buffer); }

  private checkRegion(ptr: number, len: number, what: string) {
    if (!Number.isInteger(ptr) || ptr <= 0 || ptr % 4 !== 0 || ptr + len > this.bytes) throw new PluginPrepareError('BAD_POINTER', `${what} ptr ${ptr} len ${len} outside memory ${this.bytes}`);
  }

  /** 정지 중 준비: create → configure(state JSON) → bind_sample → 포인터 검증 */
  prepare(stateJson: string, samples: SampleBinding[]): void {
    const m = this.manifest;
    if (this.ex.abi_version() >>> 0 !== ABI1_VERSION) throw new PluginPrepareError('ABI_MISMATCH', `abi_version ${(this.ex.abi_version() >>> 0).toString(16)}`);
    this.handle = this.ex.create(this.sampleRate, this.maxFrames);
    if (!this.handle) throw new PluginPrepareError('CREATE_FAILED', 'create returned 0');
    const js = utf8(stateJson);
    if (js.length > m.maxStateBytes && js.length > 2) throw new PluginPrepareError('STATE_TOO_LARGE', `${js.length} > ${m.maxStateBytes}`);
    const jp = this.ex.alloc(Math.max(1, js.length));
    if (!jp) throw new PluginPrepareError('ALLOC_FAILED', 'state');
    this.refreshViews(); this.checkRegion(jp, js.length, 'state');
    new Uint8Array(this.ex.memory.buffer, jp, js.length).set(js);
    const rc = this.ex.configure(this.handle, jp, js.length);
    if (rc < 0) throw new PluginPrepareError('CONFIGURE_FAILED', `configure returned ${rc}`);
    samples.forEach((s, slot) => {
      const ch = s.channels.length, frames = s.channels[0].length;
      const p = this.ex.alloc(ch * frames * 4);
      if (!p) throw new PluginPrepareError('MEMORY_BUDGET', `cannot allocate sample slot ${slot} (${ch}×${frames})`);
      this.refreshViews(); this.checkRegion(p, ch * frames * 4, `sample ${slot}`);
      for (let c = 0; c < ch; c++) this.f32.set(s.channels[c], p / 4 + c * frames); // planar float32
      const r = this.ex.bind_sample(this.handle, slot, p, ch, frames, s.sampleRate);
      if (r < 0) throw new PluginPrepareError('BIND_FAILED', `bind_sample slot ${slot} returned ${r}`);
    });
    this.refreshViews();
    this.inPtr = []; this.outPtr = [];
    for (let c = 0; c < m.channels.inputs; c++) { const p = this.ex.input_ptr(this.handle, c); this.checkRegion(p, this.maxFrames * 4, `input ${c}`); this.inPtr.push(p); }
    for (let c = 0; c < m.channels.outputs; c++) { const p = this.ex.output_ptr(this.handle, c); this.checkRegion(p, this.maxFrames * 4, `output ${c}`); this.outPtr.push(p); }
    this.evPtr = this.ex.events_ptr(this.handle); this.checkRegion(this.evPtr, MAX_EVENTS_PER_SUBBLOCK * EV_SIZE, 'events');
    this.parPtr = this.ex.params_ptr(this.handle); this.checkRegion(this.parPtr, Math.max(1, m.parameters.length) * this.maxFrames * 4, 'params');
  }

  /**
   * frames 처리. io: stereo 엔진 버퍼(effect 는 입력이자 출력, instrument 는 출력만). params[k][i]: descriptor 순서.
   * events: offset 오름차순, offset < frames. 실패 시 faulted 설정 후 false.
   */
  process(io: Float32Array[], frames: number, events: PluginEvent[], eventCount: number, params: Float32Array[], ioOffset = 0): boolean {
    if (this.faulted) return false;
    const m = this.manifest; const max = this.maxFrames;
    let e = 0;
    for (let start = 0; start < frames;) {
      let n = Math.min(max, frames - start);
      // 이벤트 1024 개 초과 시 subblock 을 추가 분할
      let e2 = e; while (e2 < eventCount && events[e2].offset < start + n) e2++;
      if (e2 - e > MAX_EVENTS_PER_SUBBLOCK) {
        const cut = events[e + MAX_EVENTS_PER_SUBBLOCK].offset;
        if (cut === events[e].offset || cut <= start) { this.faulted = 'event-overflow'; return false; }
        n = cut - start; e2 = e; while (e2 < eventCount && events[e2].offset < start + n) e2++;
      }
      const f = this.f32;
      if (this.ex.memory.buffer.byteLength !== this.bytes) { this.faulted = 'memory-growth'; return false; }
      for (let c = 0; c < this.inPtr.length; c++) {
        const base = this.inPtr[c] >> 2;
        if (this.inPtr.length === 1) for (let i = 0; i < n; i++) f[base + i] = 0.5 * (io[0][ioOffset + start + i] + io[1][ioOffset + start + i]);
        else f.set(io[c].subarray(ioOffset + start, ioOffset + start + n), base);
      }
      for (let c = 0; c < this.outPtr.length; c++) f.fill(0, this.outPtr[c] >> 2, (this.outPtr[c] >> 2) + n);
      for (let k = 0; k < m.parameters.length; k++) {
        const base = (this.parPtr >> 2) + k * max;
        if (m.parameters[k].automation === 'sample') f.set(params[k].subarray(start, start + n), base);
        else f.fill(params[k][start], base, base + n); // block/none: 첫 값 복제
      }
      let w = this.evPtr >> 2;
      for (let j = e; j < e2; j++) {
        const ev = events[j];
        this.u32[w] = ev.offset - start; this.u32[w + 1] = ev.type; this.u32[w + 2] = ev.voice; this.u32[w + 3] = ev.channel;
        f[w + 4] = ev.d0; f[w + 5] = ev.d1; f[w + 6] = ev.d2; this.u32[w + 7] = 0;
        w += 8;
      }
      let rc: number;
      try { rc = this.ex.process(this.handle, n, e2 - e); }
      catch { this.faulted = 'trap'; return false; }
      if (this.ex.memory.buffer.byteLength !== this.bytes) { this.faulted = 'memory-growth'; return false; }
      if (rc < 0) { this.faulted = 'negative-return'; return false; }
      if (rc === 1) this.tailEnded = true;
      for (let c = 0; c < 2; c++) {
        const src = this.outPtr[Math.min(c, this.outPtr.length - 1)] >> 2;
        const dst = io[c];
        let sum = 0;
        for (let i = 0; i < n; i++) { const v = f[src + i]; sum += v; dst[ioOffset + start + i] = v; }
        if (!Number.isFinite(sum)) { this.faulted = 'nan'; return false; }
      }
      e = e2; start += n;
    }
    return true;
  }

  reset(): void { if (this.handle && !this.faulted) { try { this.ex.reset(this.handle); } catch { this.faulted = 'trap'; } } }
  dispose(): void { try { if (this.handle) this.ex.destroy(this.handle); } catch { /* ignore */ } this.handle = 0; }
}
