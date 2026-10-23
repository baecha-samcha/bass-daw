// 01 §5 SPSC ring. header: read u32, write u32, generation u32, capacity u32, dropped u32.
// slot 24B little-endian: type u32, generation u32, sequence u32, payloadIndex u32, frame f64.
export const SLOT_BYTES = 24;
export const HEADER_WORDS = 8;
export const H_READ = 0, H_WRITE = 1, H_GEN = 2, H_CAP = 3, H_DROPPED = 4, H_WM_GEN = 5, H_WM_FRAME = 6;
// watermark(공급 완료 frame)는 FIFO 뒤에 갇히지 않도록 header 에 out-of-band 로 둔다(u32, modulo 2^32).

export interface Slot { type: number; generation: number; sequence: number; payloadIndex: number; frame: number }

export function createRingBuffer(capacity = 65536, shared = typeof SharedArrayBuffer !== 'undefined'): SharedArrayBuffer | ArrayBuffer {
  const bytes = HEADER_WORDS * 4 + capacity * SLOT_BYTES;
  const buf = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  new Uint32Array(buf, 0, HEADER_WORDS)[H_CAP] = capacity;
  return buf;
}

export class RingProducer {
  private h: Uint32Array; private dv: DataView; private cap: number;
  constructor(buf: SharedArrayBuffer | ArrayBuffer) {
    this.h = new Uint32Array(buf, 0, HEADER_WORDS);
    this.dv = new DataView(buf, HEADER_WORDS * 4);
    this.cap = this.h[H_CAP];
  }
  /** unsigned 차이로 사용량 계산(2^32 wrapping) */
  size(): number { return (Atomics.load(this.h, H_WRITE) - Atomics.load(this.h, H_READ)) >>> 0; }
  free(): number { return this.cap - this.size(); }
  /** 가득 차면 false — 호출자가 재시도한다(임의 drop 금지) */
  push(s: Slot): boolean {
    const w = Atomics.load(this.h, H_WRITE);
    const r = Atomics.load(this.h, H_READ);
    if (((w - r) >>> 0) >= this.cap) return false;
    const o = (w % this.cap) * SLOT_BYTES;
    this.dv.setUint32(o, s.type, true); this.dv.setUint32(o + 4, s.generation, true);
    this.dv.setUint32(o + 8, s.sequence, true); this.dv.setUint32(o + 12, s.payloadIndex, true);
    this.dv.setFloat64(o + 16, s.frame, true);
    Atomics.store(this.h, H_WRITE, (w + 1) >>> 0);
    return true;
  }
  setWatermark(generation: number, frame: number) {
    Atomics.store(this.h, H_WM_FRAME, frame >>> 0);
    Atomics.store(this.h, H_WM_GEN, generation >>> 0);
  }
  /** wrap 테스트용 */
  setCursorsForTest(v: number) { Atomics.store(this.h, H_WRITE, v >>> 0); Atomics.store(this.h, H_READ, v >>> 0); }
}

export class RingConsumer {
  private h: Uint32Array; private dv: DataView; private cap: number;
  constructor(buf: SharedArrayBuffer | ArrayBuffer) {
    this.h = new Uint32Array(buf, 0, HEADER_WORDS);
    this.dv = new DataView(buf, HEADER_WORDS * 4);
    this.cap = this.h[H_CAP];
  }
  available(): number { return (Atomics.load(this.h, H_WRITE) - Atomics.load(this.h, H_READ)) >>> 0; }
  /** 다음 slot 의 frame 을 미리 본다(없으면 Infinity). wait/lock 하지 않는다. */
  peekFrame(): number {
    const r = Atomics.load(this.h, H_READ);
    if (Atomics.load(this.h, H_WRITE) === r) return Infinity;
    return this.dv.getFloat64((r % this.cap) * SLOT_BYTES + 16, true);
  }
  pop(out: Slot): boolean {
    const r = Atomics.load(this.h, H_READ);
    if (Atomics.load(this.h, H_WRITE) === r) return false;
    const o = (r % this.cap) * SLOT_BYTES;
    out.type = this.dv.getUint32(o, true); out.generation = this.dv.getUint32(o + 4, true);
    out.sequence = this.dv.getUint32(o + 8, true); out.payloadIndex = this.dv.getUint32(o + 12, true);
    out.frame = this.dv.getFloat64(o + 16, true);
    Atomics.store(this.h, H_READ, (r + 1) >>> 0);
    return true;
  }
  addDropped(n: number) { Atomics.add(this.h, H_DROPPED, n); }
  watermarkGeneration(): number { return Atomics.load(this.h, H_WM_GEN); }
  /** 현재 frame 근처로 u32 watermark 를 복원 */
  watermarkFrame(near: number): number {
    const low = Atomics.load(this.h, H_WM_FRAME);
    const diff = ((low - (near >>> 0)) | 0); // signed 32-bit 차이
    return near + diff;
  }
}

/** MessagePort fallback: 같은 slot 계약을 transferable batch 로 전달 */
export function encodeBatch(slots: Slot[]): ArrayBuffer {
  const b = new ArrayBuffer(slots.length * SLOT_BYTES); const dv = new DataView(b);
  slots.forEach((s, i) => { const o = i * SLOT_BYTES; dv.setUint32(o, s.type, true); dv.setUint32(o + 4, s.generation, true); dv.setUint32(o + 8, s.sequence, true); dv.setUint32(o + 12, s.payloadIndex, true); dv.setFloat64(o + 16, s.frame, true); });
  return b;
}
export function decodeBatch(b: ArrayBuffer): Slot[] {
  const dv = new DataView(b); const out: Slot[] = [];
  for (let o = 0; o + SLOT_BYTES <= b.byteLength; o += SLOT_BYTES) out.push({ type: dv.getUint32(o, true), generation: dv.getUint32(o + 4, true), sequence: dv.getUint32(o + 8, true), payloadIndex: dv.getUint32(o + 12, true), frame: dv.getFloat64(o + 16, true) });
  return out;
}
