// 3-band peaking EQ (RBJ cookbook), Transposed Direct Form II. 파라미터는 block-rate.
import type { EffectDsp } from './types.ts';

export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = [0, 0]; z2 = [0, 0];
  setPeaking(fs: number, f: number, gainDb: number, q: number) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0; this.b1 = (-2 * cw) / a0; this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha / A) / a0;
  }
  run(ch: number, x: Float32Array, n: number) {
    let z1 = this.z1[ch], z2 = this.z2[ch];
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const y = b0 * xi + z1;
      z1 = b1 * xi - a1 * y + z2;
      z2 = b2 * xi - a2 * y;
      x[i] = y;
    }
    this.z1[ch] = z1; this.z2[ch] = z2;
  }
  reset() { this.z1 = [0, 0]; this.z2 = [0, 0]; }
  /** 분석용: 주파수 응답 크기 */
  magnitude(fs: number, f: number): number {
    const w = (2 * Math.PI * f) / fs;
    const re = (c0: number, c1: number, c2: number) => c0 + c1 * Math.cos(-w) + c2 * Math.cos(-2 * w);
    const im = (c0: number, c1: number, c2: number) => c1 * Math.sin(-w) + c2 * Math.sin(-2 * w);
    const nr = re(this.b0, this.b1, this.b2), ni = im(this.b0, this.b1, this.b2);
    const dr = re(1, this.a1, this.a2), di = im(1, this.a1, this.a2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
}

export class EqDsp implements EffectDsp {
  readonly latencyFrames = 0;
  readonly tailFrames: number;
  diagnostics: string[] = [];
  bands = [new Biquad(), new Biquad(), new Biquad()];
  private last = new Float64Array(9).fill(NaN);
  constructor(private fs: number) { this.tailFrames = Math.round(fs * 0.05); }
  process(io: Float32Array[], frames: number, params: Float32Array[]): void {
    for (let b = 0; b < 3; b++) {
      let f = params[b * 3][0]; const g = params[b * 3 + 1][0]; const q = params[b * 3 + 2][0];
      const nyq = 0.49 * this.fs;
      if (f >= nyq) { f = nyq * 0.999; if (this.diagnostics.length < 8) this.diagnostics.push(`EQ_FREQ_CLAMPED band${b + 1}`); }
      if (f !== this.last[b * 3] || g !== this.last[b * 3 + 1] || q !== this.last[b * 3 + 2]) {
        this.bands[b].setPeaking(this.fs, f, g, q);
        this.last[b * 3] = f; this.last[b * 3 + 1] = g; this.last[b * 3 + 2] = q;
      }
      if (g === 0) continue; // 0dB peaking 은 항등 — 상태만 유지
      this.bands[b].run(0, io[0], frames); this.bands[b].run(1, io[1], frames);
    }
  }
  reset() { for (const b of this.bands) b.reset(); }
}
