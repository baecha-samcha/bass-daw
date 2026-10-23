// 의존성 없는 SHA-256 (FIPS 180-4). Worker/Worklet/Node 어디서나 동기·증분 해시가 필요해 직접 구현한다.
// 큰 버퍼는 가능하면 sha256Hex(WebCrypto)를 사용한다.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('Sha256 already finalized');
    let i = 0;
    this.total += data.length;
    if (this.bufLen > 0) {
      const n = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, n), this.bufLen);
      this.bufLen += n; i = n;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.bufLen = data.length - i; }
    return this;
  }

  /** 재개 가능한 검증 작업용 상태 직렬화(서버 incremental verifier 가 D1 에 저장). finalize 전만 가능. */
  exportState(): { h: number[]; buf: string; total: number } {
    if (this.done) throw new Error('Sha256 already finalized');
    let b = ''; for (let i = 0; i < this.bufLen; i++) b += this.buf[i].toString(16).padStart(2, '0');
    return { h: Array.from(this.h), buf: b, total: this.total };
  }
  static fromState(s: { h: number[]; buf: string; total: number }): Sha256 {
    const x = new Sha256();
    if (s.h.length !== 8 || s.buf.length % 2 || s.buf.length > 126 || !Number.isSafeInteger(s.total) || s.total < 0) throw new Error('bad Sha256 state');
    x.h.set(s.h.map((v) => v >>> 0));
    for (let i = 0; i < s.buf.length / 2; i++) x.buf[i] = parseInt(s.buf.slice(i * 2, i * 2 + 2), 16);
    x.bufLen = s.buf.length / 2; x.total = s.total;
    return x;
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) {
      const j = o + t * 4;
      w[t] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const ch = (E & F) ^ (~E & G);
      const t1 = (H + S1 + ch + K[t] + w[t]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const t2 = (S0 + maj) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0;
    h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + G) | 0; h[7] = (h[7] + H) | 0;
  }

  digestHex(): string {
    if (!this.done) {
      const bits = this.total * 8;
      const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
      pad[0] = 0x80;
      const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
      const n = pad.length;
      pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
      pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
      const total = this.total;
      this.update(pad);
      this.total = total;
      this.done = true;
    }
    let s = '';
    for (const v of this.h) s += (v >>> 0).toString(16).padStart(8, '0');
    return s;
  }
}

export function sha256HexSync(data: Uint8Array): string {
  return new Sha256().update(data).digestHex();
}

/** WebCrypto 가 있으면 사용, 없으면 동기 구현으로 대체. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle) {
    const d = await subtle.digest('SHA-256', data as unknown as BufferSource);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexSync(data);
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
