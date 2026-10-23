// 고정 길이 stereo delay line (PDC·lookahead·predelay)
export class DelayLine {
  private buf: Float32Array[]; private pos = 0;
  constructor(readonly length: number, channels = 2) {
    this.buf = Array.from({ length: channels }, () => new Float32Array(Math.max(1, length)));
  }
  /** in-place: io[c][i] ← io[c][i - length] */
  process(io: Float32Array[], frames: number): void {
    if (this.length === 0) return;
    const L = this.length;
    for (let c = 0; c < this.buf.length; c++) {
      const b = this.buf[c]; const x = io[c]; let p = this.pos;
      for (let i = 0; i < frames; i++) { const y = b[p]; b[p] = x[i]; x[i] = y; p = p + 1 === L ? 0 : p + 1; }
    }
    this.pos = (this.pos + frames) % L;
  }
  reset() { for (const b of this.buf) b.fill(0); this.pos = 0; }
}
