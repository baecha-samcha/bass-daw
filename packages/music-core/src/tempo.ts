// 01 §3: step tempo map 시간 변환. seconds(t)=누적초_i + (t-tick_i)*60/(bpm_i*960)
import type { TempoPoint, MeterPoint, Tick } from '@bass-daw/schemas';
import { PPQ } from '@bass-daw/schemas';

export class TempoMap {
  readonly points: readonly TempoPoint[];
  private startSeconds: Float64Array;

  constructor(points: readonly TempoPoint[]) {
    if (points.length === 0 || points[0].tick !== 0) throw new Error('tempo map requires tick 0');
    this.points = points;
    this.startSeconds = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      this.startSeconds[i] = this.startSeconds[i - 1] + ((points[i].tick - a.tick) * 60) / (a.bpm * PPQ);
    }
  }

  private segmentForTick(t: number): number {
    let lo = 0, hi = this.points.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.points[mid].tick <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  tickToSeconds(t: number): number {
    const i = this.segmentForTick(t);
    const p = this.points[i];
    return this.startSeconds[i] + ((t - p.tick) * 60) / (p.bpm * PPQ);
  }

  /** inverse: 실수 Tick 반환. 편집 시에만 반올림한다. */
  secondsToTick(s: number): number {
    let lo = 0, hi = this.points.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.startSeconds[mid] <= s) lo = mid; else hi = mid - 1; }
    const p = this.points[lo];
    return p.tick + ((s - this.startSeconds[lo]) * p.bpm * PPQ) / 60;
  }

  /** frame(t)=round(seconds(t)*sampleRate) — 구간별 delta 누적 반올림을 하지 않는다. */
  tickToFrame(t: number, sampleRate: number, offsetSeconds = 0): number {
    return Math.round((this.tickToSeconds(t) + offsetSeconds) * sampleRate);
  }

  bpmAt(t: number): number { return this.points[this.segmentForTick(t)].bpm; }
}

export interface BarBeat { bar: number; beat: number; tickInBeat: number }

export class MeterMap {
  constructor(readonly points: readonly MeterPoint[]) {}
  static ticksPerBar(m: MeterPoint): number { return (m.numerator * PPQ * 4) / m.denominator; }
  static ticksPerBeat(m: MeterPoint): number { return (PPQ * 4) / m.denominator; }

  /** 시작 마디는 1 */
  tickToBarBeat(t: Tick): BarBeat {
    let bar = 1;
    for (let i = 0; i < this.points.length; i++) {
      const m = this.points[i];
      const end = this.points[i + 1]?.tick ?? Infinity;
      const tpb = MeterMap.ticksPerBar(m);
      if (t < end) {
        const rel = t - m.tick;
        const barsIn = Math.floor(rel / tpb);
        const inBar = rel - barsIn * tpb;
        const beatT = MeterMap.ticksPerBeat(m);
        return { bar: bar + barsIn, beat: Math.floor(inBar / beatT) + 1, tickInBeat: inBar % beatT };
      }
      bar += (end - m.tick) / tpb;
    }
    return { bar, beat: 1, tickInBeat: 0 };
  }

  barToTick(bar: number): Tick {
    let curBar = 1;
    for (let i = 0; i < this.points.length; i++) {
      const m = this.points[i];
      const tpb = MeterMap.ticksPerBar(m);
      const next = this.points[i + 1];
      const barsHere = next ? (next.tick - m.tick) / tpb : Infinity;
      if (bar - curBar < barsHere) return m.tick + (bar - curBar) * tpb;
      curBar += barsHere;
    }
    return 0;
  }

  meterAt(t: Tick): MeterPoint {
    let r = this.points[0];
    for (const m of this.points) if (m.tick <= t) r = m;
    return r;
  }

  /** [startTick, endTick) 의 마디선 tick 목록 */
  barLines(startTick: Tick, endTick: Tick): Tick[] {
    const out: Tick[] = [];
    for (let i = 0; i < this.points.length; i++) {
      const m = this.points[i];
      const end = Math.min(this.points[i + 1]?.tick ?? Infinity, endTick);
      const tpb = MeterMap.ticksPerBar(m);
      let t = m.tick + Math.max(0, Math.ceil((startTick - m.tick) / tpb)) * tpb;
      for (; t < end; t += tpb) out.push(t);
    }
    return out;
  }
}

export function snapTick(t: number, grid: number): Tick {
  return Math.max(0, Math.round(t / grid) * grid);
}
