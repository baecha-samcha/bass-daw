// 독립 시간 오라클 (05 §5). 엔진 tickToFrame 를 재사용하지 않고 BigInt 유리수로 tempo 구간을 적분한다.
export interface OTempo { tick: number; bpm: number }

function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }
class Q {
  constructor(public n: bigint, public d: bigint) { const g = gcd(n, d) || 1n; this.n = n / g; this.d = d / g; if (this.d < 0n) { this.n = -this.n; this.d = -this.d; } }
  add(o: Q) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  mul(o: Q) { return new Q(this.n * o.n, this.d * o.d); }
  round(): bigint { // round half away from zero, same as Math.round for positives
    const twice = (2n * this.n + this.d) ; return twice >= 0n ? twice / (2n * this.d) : -((-twice + 2n * this.d - 1n) / (2n * this.d));
  }
}
const qOf = (x: number): Q => { // 소수 bpm 지원: 소수점 이하 6자리까지
  const s = Math.round(x * 1e6); return new Q(BigInt(s), 1_000_000n);
};

/** expected frame of tick t at sampleRate sr (+ optional extra seconds as rational ms) */
export function oracleFrame(tempo: OTempo[], t: number, sr: number, extraMs = 0): number {
  let sec = new Q(0n, 1n);
  for (let i = 0; i < tempo.length; i++) {
    const a = tempo[i];
    if (a.tick >= t) break;
    const end = Math.min(t, tempo[i + 1]?.tick ?? Infinity);
    // Δticks * 60 / (bpm * 960)
    sec = sec.add(new Q(BigInt(end - a.tick) * 60n, 960n).mul(new Q(qOf(a.bpm).d, qOf(a.bpm).n)));
  }
  sec = sec.add(new Q(BigInt(Math.round(extraMs * 1000)), 1_000_000n));
  return Number(sec.mul(new Q(BigInt(sr), 1n)).round());
}
