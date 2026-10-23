// 제한된 IR convolution reverb (01 §6). 균일 분할 overlap-save.
// 분할 경계의 계산(FFT·주파수 곱·IFFT)을 다음 분할 구간 동안 작업 단위로 나눠 수행해 block 처리 시간을 평탄화한다.
// 그 대가로 latency = 2 × 분할(PDC 보상 대상, decisions/0006).
import type { EffectDsp } from './types.ts';
import { FFT } from './fft.ts';
import { DelayLine } from './delay.ts';

export const REVERB_PARTITION = 1024;
export const REVERB_LATENCY = 2 * REVERB_PARTITION;
export const MAX_IR_SECONDS = 2;

/** 한 채널의 분산 실행 convolver. 작업 단위: [bitrev, fwd stage×S, store, MAC×P, mirror+bitrev, inv stage×S, output] */
class SpreadConvolver {
  private fft: FFT; readonly B: number; private P: number; private S: number;
  private irRe: Float32Array[]; private irIm: Float32Array[];
  private fdlRe: Float32Array[]; private fdlIm: Float32Array[]; private head = 0;
  private prevIn: Float64Array; private re: Float64Array; private im: Float64Array; private accRe: Float64Array; private accIm: Float64Array;
  /** 처리 중인 입력 분할의 결과(다음 경계에 재생 시작) */
  outNext: Float32Array; private job = -1; readonly units: number;

  constructor(ir: Float32Array, B: number) {
    this.B = B; const N = 2 * B; this.fft = new FFT(N); this.S = this.fft.stages;
    this.P = Math.max(1, Math.ceil(ir.length / B));
    this.irRe = []; this.irIm = []; this.fdlRe = []; this.fdlIm = [];
    for (let p = 0; p < this.P; p++) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < B && p * B + i < ir.length; i++) re[i] = ir[p * B + i];
      this.fft.transform(re, im);
      // 실수 신호의 켤레 대칭: 0..N/2 bin 만 Float32 로 저장
      this.irRe.push(Float32Array.from(re.subarray(0, B + 1))); this.irIm.push(Float32Array.from(im.subarray(0, B + 1)));
      this.fdlRe.push(new Float32Array(B + 1)); this.fdlIm.push(new Float32Array(B + 1));
    }
    this.prevIn = new Float64Array(B); this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.accRe = new Float64Array(N); this.accIm = new Float64Array(N);
    this.outNext = new Float32Array(B);
    this.units = 1 + this.S + 1 + this.P + 1 + this.S + 1;
  }

  /** 경계: 새 입력 분할로 작업 시작(이전 작업은 반드시 끝난 상태여야 함) */
  begin(x: Float32Array): void {
    if (this.job >= 0) this.run(Infinity);
    const B = this.B, re = this.re, im = this.im;
    for (let i = 0; i < B; i++) { re[i] = this.prevIn[i]; re[B + i] = x[i]; im[i] = 0; im[B + i] = 0; this.prevIn[i] = x[i]; }
    this.job = 0;
  }
  get remaining(): number { return this.job < 0 ? 0 : this.units - this.job; }

  /** 최대 n 작업 단위 실행 */
  run(n: number): void {
    const S = this.S, P = this.P, B = this.B, N = 2 * B;
    while (this.job >= 0 && n-- > 0) {
      const u = this.job;
      if (u === 0) this.fft.bitReverse(this.re, this.im);
      else if (u <= S) this.fft.stage(this.re, this.im, u - 1, false);
      else if (u === S + 1) {
        this.head = (this.head + P - 1) % P;
        this.fdlRe[this.head].set(this.re.subarray(0, B + 1)); this.fdlIm[this.head].set(this.im.subarray(0, B + 1));
        this.accRe.fill(0); this.accIm.fill(0);
      } else if (u <= S + 1 + P) {
        const p = u - (S + 2);
        const fr = this.fdlRe[(this.head + p) % P], fi = this.fdlIm[(this.head + p) % P];
        const hr = this.irRe[p], hi = this.irIm[p]; const ar = this.accRe, ai = this.accIm;
        for (let k = 0; k <= B; k++) { ar[k] += fr[k] * hr[k] - fi[k] * hi[k]; ai[k] += fr[k] * hi[k] + fi[k] * hr[k]; }
      } else if (u === S + 2 + P) {
        const ar = this.accRe, ai = this.accIm;
        for (let k = B + 1; k < N; k++) { ar[k] = ar[N - k]; ai[k] = -ai[N - k]; }
        this.fft.bitReverse(ar, ai);
      } else if (u <= 2 * S + 2 + P) this.fft.stage(this.accRe, this.accIm, u - (S + 3 + P), true);
      else {
        for (let i = 0; i < B; i++) this.outNext[i] = this.accRe[B + i] / N;
        this.job = -2; // 아래 ++ 로 -1 (완료)
      }
      this.job++;
    }
  }

  reset(): void {
    for (const f of this.fdlRe) f.fill(0); for (const f of this.fdlIm) f.fill(0);
    this.prevIn.fill(0); this.outNext.fill(0); this.job = -1;
  }
}

/** 결정적 합성 IR: 지수 감쇠 노이즈(seed 고정) — IR 자산이 없을 때 사용 */
export function syntheticIr(fs: number, seconds = 1, seed = 20261022): Float32Array[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = Math.round(fs * seconds);
  return [0, 1].map(() => {
    const ir = new Float32Array(n);
    for (let i = 0; i < n; i++) ir[i] = (rnd() * 2 - 1) * Math.exp((-6.9 * i) / n) * 0.12;
    return ir;
  });
}

export class ReverbDsp implements EffectDsp {
  readonly latencyFrames = REVERB_LATENCY;
  readonly tailFrames: number;
  diagnostics: string[] = [];
  private conv: SpreadConvolver[];
  private inBuf: Float32Array[]; private outBuf: Float32Array[]; private fill = 0;
  private wetTmp: Float32Array[]; private dryDelay: DelayLine; private pre: DelayLine;
  constructor(fs: number, ir: Float32Array[], predelayMs: number) {
    const maxLen = Math.round(fs * MAX_IR_SECONDS);
    const irs = (ir.length === 1 ? [ir[0], ir[0]] : ir).map((x) => (x.length > maxLen ? x.subarray(0, maxLen) : x));
    if (ir[0].length > maxLen) this.diagnostics.push('REVERB_IR_TRUNCATED');
    const B = REVERB_PARTITION;
    this.conv = irs.map((x) => new SpreadConvolver(x, B));
    this.inBuf = [new Float32Array(B), new Float32Array(B)];
    this.outBuf = [new Float32Array(B), new Float32Array(B)];
    this.wetTmp = [new Float32Array(4096), new Float32Array(4096)];
    this.dryDelay = new DelayLine(REVERB_LATENCY);
    this.pre = new DelayLine(Math.round((predelayMs * fs) / 1000));
    this.tailFrames = irs[0].length + this.pre.length + REVERB_LATENCY;
  }
  process(io: Float32Array[], frames: number, params: Float32Array[]): void {
    const wet = params[0], dry = params[1];
    const B = REVERB_PARTITION;
    if (this.wetTmp[0].length < frames) this.wetTmp = [new Float32Array(frames), new Float32Array(frames)];
    const w = this.wetTmp;
    w[0].set(io[0].subarray(0, frames)); w[1].set(io[1].subarray(0, frames));
    this.pre.process(w, frames);
    let i = 0;
    while (i < frames) {
      const n = Math.min(frames - i, B - this.fill);
      // 이번 구간 길이에 비례해 진행 중 작업 수행(경계 전에 반드시 완료)
      for (const cv of this.conv) cv.run(Math.ceil((cv.remaining * n) / (B - this.fill)));
      for (let c = 0; c < 2; c++) {
        const x = w[c], ib = this.inBuf[c], ob = this.outBuf[c];
        for (let k = 0; k < n; k++) { const v = x[i + k]; x[i + k] = ob[this.fill + k]; ib[this.fill + k] = v; }
      }
      this.fill += n; i += n;
      if (this.fill === B) {
        // 경계: 직전 분할의 결과를 재생 버퍼로, 방금 모은 분할의 작업 시작
        for (let c = 0; c < 2; c++) { this.conv[c].run(Infinity); this.outBuf[c].set(this.conv[c].outNext); this.conv[c].begin(this.inBuf[c]); }
        this.fill = 0;
      }
    }
    this.dryDelay.process(io, frames);
    for (let c = 0; c < 2; c++) { const x = io[c], y = w[c]; for (let k = 0; k < frames; k++) x[k] = x[k] * dry[k] + y[k] * wet[k]; }
  }
  reset() { for (const c of this.conv) c.reset(); this.fill = 0; for (const b of [...this.inBuf, ...this.outBuf]) b.fill(0); this.dryDelay.reset(); this.pre.reset(); }
}
