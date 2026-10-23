// Feed-forward stereo-linked compressor, hard knee, 명시적 lookahead latency (01 §6, 03 §2).
import type { EffectDsp } from './types.ts';
import { DelayLine } from './delay.ts';

export class CompressorDsp implements EffectDsp {
  readonly latencyFrames: number;
  readonly tailFrames: number;
  diagnostics: string[] = [];
  private env = 0; // 현재 gain reduction dB (≥0)
  private delay: DelayLine;
  gainReductionDb = 0;
  /** lookaheadMs 는 정지 중에만 바뀐다 — 생성 시 고정 */
  constructor(private fs: number, lookaheadMs: number) {
    this.latencyFrames = Math.round((lookaheadMs * fs) / 1000);
    this.delay = new DelayLine(this.latencyFrames);
    this.tailFrames = Math.round(fs * 2);
  }
  process(io: Float32Array[], frames: number, params: Float32Array[]): void {
    const thr = params[0][0], ratio = params[1][0], atk = params[2][0], rel = params[3][0], makeup = params[4][0];
    const ca = Math.exp(-1000 / (Math.max(0.1, atk) * this.fs));
    const cr = Math.exp(-1000 / (Math.max(1, rel) * this.fs));
    const slope = 1 - 1 / ratio;
    const L = io[0], R = io[1];
    // detector 는 지연되지 않은 신호, gain 은 지연된 신호에 적용 → lookahead
    const gains = this.scratch(frames);
    let env = this.env;
    for (let i = 0; i < frames; i++) {
      const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const lvl = peak > 1e-9 ? 20 * Math.log10(peak) : -180;
      const target = lvl > thr ? (lvl - thr) * slope : 0;
      env = target > env ? ca * env + (1 - ca) * target : cr * env + (1 - cr) * target;
      gains[i] = Math.pow(10, (makeup - env) / 20);
    }
    this.env = env; this.gainReductionDb = env;
    this.delay.process(io, frames);
    for (let i = 0; i < frames; i++) { L[i] *= gains[i]; R[i] *= gains[i]; }
  }
  private sc = new Float32Array(0);
  private scratch(n: number) { if (this.sc.length < n) this.sc = new Float32Array(Math.max(n, 512)); return this.sc; }
  reset() { this.env = 0; this.delay.reset(); }
}
