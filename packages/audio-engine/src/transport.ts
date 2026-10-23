// Transport 상태 기계 + Scheduler(큐 공급) + WorkletRuntime(렌더 스레드 소비자) — 순수 로직 (01 §4–5).
// 브라우저 glue(processor.ts / scheduler.worker.ts / engine.ts)는 이 클래스를 감싸기만 한다.
import type { EventTable } from './plan.ts';
import { EV_NOTE_OFF, EV_ALL_OFF, SLOT_LOCATE, SLOT_WATERMARK } from './plan.ts';
import type { Slot } from './ring.ts';
import type { RenderCore } from './core.ts';

// ---------------- 상태 기계 ----------------
export type EngineState = 'uninitialized' | 'preparing' | 'ready' | 'playing' | 'paused' | 'suspended' | 'recovering' | 'error' | 'closed';
const ALLOWED: Record<EngineState, EngineState[]> = {
  uninitialized: ['preparing', 'closed', 'error'],
  preparing: ['ready', 'error', 'closed'],
  ready: ['playing', 'preparing', 'suspended', 'error', 'closed', 'ready'],
  playing: ['paused', 'ready', 'suspended', 'recovering', 'error', 'closed', 'playing'],
  paused: ['playing', 'ready', 'preparing', 'suspended', 'error', 'closed', 'paused'],
  suspended: ['paused', 'recovering', 'error', 'closed'],
  recovering: ['paused', 'error', 'closed'],
  error: ['recovering', 'closed'],
  closed: [],
};
export class EngineStateMachine {
  state: EngineState = 'uninitialized';
  history: EngineState[] = ['uninitialized'];
  can(to: EngineState) { return ALLOWED[this.state].includes(to); }
  to(next: EngineState): void {
    if (!this.can(next)) throw new Error(`INVALID_TRANSITION ${this.state}→${next}`);
    this.state = next; this.history.push(next);
  }
}

// ---------------- Scheduler (producer) ----------------
export interface LoopRt { enabled: boolean; startFrame: number; endFrame: number }

/**
 * timeline frame → context frame 매핑으로 이벤트를 lookahead 창까지 공급한다.
 * 루프 경계에서 LOCATE slot 을 넣고 다음 반복 이벤트를 누락·중복 없이 이어 붙인다.
 * push 가 false(큐 가득)면 상태를 유지한 채 반환 — 다음 tick 에 재시도(임의 drop 금지).
 */
export class Scheduler {
  fedUntil: number;
  private segTf: number; private segCf: number; private segEndTf: number; private idx: number;
  private seq = 0;
  private pendingLocate = false;
  private extra: Slot[] = [];

  constructor(public table: EventTable, public loop: LoopRt, startTf: number, public anchorCf: number, public generation: number, public planVersion = 0) {
    this.segTf = startTf; this.segCf = anchorCf; this.fedUntil = anchorCf;
    this.segEndTf = loop.enabled && startTf < loop.endFrame ? loop.endFrame : Infinity;
    this.idx = lowerBound(table.frame, table.count, startTf);
  }

  /** 재생 중 plan 교체: 가장 이른 미확정 frame(fedUntil) 이후부터 새 표로 공급, 변경 트랙 voice 종료 */
  replaceTable(table: EventTable, planVersion: number, killTrackPayloads: number[]): void {
    this.table = table; this.planVersion = planVersion;
    const tfAtFed = this.segTf + (this.fedUntil - this.segCf);
    this.idx = lowerBound(table.frame, table.count, tfAtFed);
    for (const p of killTrackPayloads) this.extra.push({ type: slotType(EV_ALL_OFF, planVersion), generation: this.generation, sequence: 0, payloadIndex: p, frame: this.fedUntil });
  }

  timelineAt(cf: number): number { return this.segTf + (cf - this.segCf); }

  fill(untilCf: number, push: (s: Slot) => boolean): void {
    const t = this.table;
    while (this.extra.length) { const s = this.extra[0]; s.sequence = this.seq; if (!push(s)) return; this.seq++; this.extra.shift(); }
    while (this.fedUntil < untilCf) {
      if (this.pendingLocate) {
        if (!push({ type: SLOT_LOCATE, generation: this.generation, sequence: this.seq, payloadIndex: 0, frame: this.segCf })) { this.fedUntil = Math.max(this.fedUntil, this.segCf); return; }
        this.seq++; this.pendingLocate = false;
      }
      const segEndCf = this.segEndTf === Infinity ? Infinity : this.segCf + (this.segEndTf - this.segTf);
      const windowEnd = Math.min(untilCf, segEndCf);
      while (this.idx < t.count) {
        const tf = t.frame[this.idx];
        if (tf >= this.segEndTf) break;
        const cf = this.segCf + (tf - this.segTf);
        if (cf >= windowEnd) break;
        // 큐가 가득 차면 이 이벤트 직전까지만 공급 완료로 기록하고 다음 tick 에 재시도
        if (!push({ type: slotType(t.kind[this.idx], this.planVersion), generation: this.generation, sequence: this.seq, payloadIndex: this.idx, frame: cf })) { this.fedUntil = Math.max(this.fedUntil, cf); return; }
        this.seq++; this.idx++;
      }
      this.fedUntil = windowEnd;
      if (windowEnd === segEndCf) {
        // 루프 경계: [start,end) 반개구간 — end 의 이벤트는 다음 반복의 start 위치로 넘어간다
        this.segCf = segEndCf; this.segTf = this.loop.startFrame; this.segEndTf = this.loop.endFrame;
        this.idx = lowerBound(t.frame, t.count, this.loop.startFrame);
        this.pendingLocate = true;
      }
    }
  }

  /** MessagePort 경로용 watermark slot (SAB 경로는 header 에 기록) */
  watermarkSlot(): Slot { return { type: SLOT_WATERMARK, generation: this.generation, sequence: this.seq, payloadIndex: 0, frame: this.fedUntil }; }
}

export function slotType(kind: number, planVersion: number): number { return ((planVersion & 0xffffff) << 8) | (kind & 0xff); }
export function slotKind(type: number): number { return type & 0xff; }
export function slotPlan(type: number): number { return type >>> 8; }

export function lowerBound(a: Float64Array, n: number, x: number): number {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

// ---------------- WorkletRuntime (consumer) ----------------
export interface RuntimeStatus {
  state: 'idle' | 'starting' | 'playing'; generation: number; contextFrame: number; timelineFrame: number;
  late: number; stale: number; underruns: number; lowWater: number; dropped: number; fedUntil: number;
}
export type RuntimeNotice =
  | { type: 'ack'; op: 'play' | 'pause' | 'stop' | 'seek'; generation: number; anchorCf: number; timelineFrame: number }
  | { type: 'underrun'; generation: number; timelineFrame: number }
  | { type: 'plan'; planVersion: number };

/** 렌더 스레드의 큐 소비 로직. 할당 없는 고정 버퍼를 사용한다. */
export class WorkletRuntime {
  core: RenderCore;
  tables = new Map<number, EventTable>();
  state: RuntimeStatus['state'] = 'idle';
  generation = 0;
  contextFrame = 0;
  anchorCf = 0;
  fedUntil = 0;
  counters = { late: 0, stale: 0, underruns: 0, lowWater: 0 };
  lowWaterFrames: number;
  /** actions: [offset, code(0=event,1=locate), payload, planVersion] */
  private act = new Int32Array(4 * 8192);
  private pending = new Int32Array(2 * 8192);
  private loopStart = 0;
  private slot: Slot = { type: 0, generation: 0, sequence: 0, payloadIndex: 0, frame: 0 };
  private pendingTables: { planVersion: number; table: EventTable }[] = [];
  private views: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  notices: RuntimeNotice[] = [];

  constructor(core: RenderCore, public leadFrames: number) {
    this.core = core;
    this.lowWaterFrames = Math.round(core.sr * 0.1); // underrun 조기 경보 100ms
    this.loopStart = core.graph.loop.startFrame;
  }

  setTable(planVersion: number, table: EventTable): void { this.pendingTables.push({ planVersion, table }); }
  /** out-of-band watermark: 현재 generation 의 공급 완료 frame */
  watermark(generation: number, frame: number): void { if (generation === this.generation && frame > this.fedUntil) this.fedUntil = frame; }
  setLoopStart(f: number): void { this.loopStart = f; }

  /** control mailbox (큐와 별개). 다음 block boundary 에서 적용되며 ack 를 남긴다. */
  control(op: 'play' | 'pause' | 'stop' | 'seek', generation: number, timelineFrame: number): void {
    this.generation = generation;
    this.fedUntil = 0;
    this.core.locate(timelineFrame);
    if (op === 'play') { this.anchorCf = this.contextFrame + this.leadFrames; this.state = 'starting'; }
    else { this.state = 'idle'; this.anchorCf = this.contextFrame; }
    this.notices.push({ type: 'ack', op, generation, anchorCf: this.anchorCf, timelineFrame });
  }

  /**
   * 한 block 처리. 실제 output buffer 길이(frames)를 사용하고 128 을 가정하지 않는다.
   * event.frame = blockEnd 는 이 block 에 포함하지 않는다.
   */
  process(out: Float32Array[], frames: number, peekFrame: () => number, pop: (s: Slot) => boolean): void {
    if (this.pendingTables.length) {
      for (const t of this.pendingTables) this.tables.set(t.planVersion, t.table);
      this.notices.push({ type: 'plan', planVersion: this.pendingTables[this.pendingTables.length - 1].planVersion });
      this.pendingTables.length = 0;
      while (this.tables.size > 2) { let min = Infinity; for (const k of this.tables.keys()) if (k < min) min = k; this.tables.delete(min); }
    }
    const blockStart = this.contextFrame, blockEnd = blockStart + frames;
    let na = 0;
    while (peekFrame() < blockEnd) {
      if (!pop(this.slot)) break;
      const s = this.slot;
      if (s.generation !== this.generation) { this.counters.stale++; continue; }
      if (s.type === SLOT_WATERMARK) { if (s.frame > this.fedUntil) this.fedUntil = s.frame; continue; }
      const off = s.frame - blockStart;
      if (s.type === SLOT_LOCATE) {
        if (na * 4 + 4 <= this.act.length) { this.act[4 * na] = Math.max(0, off); this.act[4 * na + 1] = 1; na++; }
        continue;
      }
      const pv = slotPlan(s.type); const kind = slotKind(s.type);
      const table = this.tables.get(pv);
      if (!table) { this.counters.stale++; continue; }
      if (off < 0 || this.state === 'idle') {
        this.counters.late++;
        // 늦은 noteOff/allOff 는 stuck voice 방지를 위해 즉시 적용, noteOn 등은 실행하지 않는다
        if (kind === EV_NOTE_OFF || kind === EV_ALL_OFF) { this.core.events = table; this.core.applyEvent(s.payloadIndex); }
        continue;
      }
      if (na * 4 + 4 > this.act.length) { this.counters.late++; continue; }
      this.act[4 * na] = off; this.act[4 * na + 1] = 0; this.act[4 * na + 2] = s.payloadIndex; this.act[4 * na + 3] = pv; na++;
    }
    let from = 0;
    if (this.state === 'starting') {
      if (this.fedUntil >= Math.min(blockEnd, this.anchorCf + 1) && blockEnd > this.anchorCf) { this.state = 'playing'; from = Math.max(0, this.anchorCf - blockStart); }
    }
    if (this.state === 'playing' && this.fedUntil < blockEnd) {
      this.counters.underruns++;
      this.core.panic();
      this.state = 'idle';
      this.notices.push({ type: 'underrun', generation: this.generation, timelineFrame: this.core.timelineFrame });
    }
    if (this.state !== 'playing') { silence(out, frames); this.contextFrame = blockEnd; return; }
    if (this.fedUntil - blockEnd < this.lowWaterFrames) this.counters.lowWater++;
    if (from > 0) silence(out, from);
    // 구간 렌더: LOCATE 또는 plan 표가 바뀌는 지점에서 분할
    let segStart = from, np = 0, curPv = -1;
    for (let k = 0; k < na; k++) {
      const off = this.act[4 * k], code = this.act[4 * k + 1];
      if (code === 1) {
        this.renderRange(out, segStart, Math.max(segStart, off), np); np = 0; segStart = Math.max(segStart, off);
        this.core.locate(this.loopStart);
        continue;
      }
      const pv = this.act[4 * k + 3];
      if (pv !== curPv) {
        if (np > 0) { this.renderRange(out, segStart, Math.max(segStart, off), np); np = 0; segStart = Math.max(segStart, off); }
        curPv = pv; this.core.events = this.tables.get(pv)!;
      }
      this.pending[2 * np] = Math.max(off, segStart); this.pending[2 * np + 1] = this.act[4 * k + 2]; np++;
    }
    this.renderRange(out, segStart, frames, np);
    this.contextFrame = blockEnd;
  }

  private renderRange(out: Float32Array[], from: number, to: number, n: number) {
    if (to <= from) return;
    for (let k = 0; k < n; k++) this.pending[2 * k] = Math.min(to - from - 1, this.pending[2 * k] - from);
    let view = out;
    if (from !== 0 || to !== out[0].length) { this.views[0] = out[0].subarray(from, to); this.views[1] = out[1].subarray(from, to); view = this.views; }
    this.core.renderBlock(view, to - from, this.pending, n);
  }

  status(): RuntimeStatus {
    return { state: this.state, generation: this.generation, contextFrame: this.contextFrame, timelineFrame: this.core.timelineFrame, late: this.counters.late, stale: this.counters.stale, underruns: this.counters.underruns, lowWater: this.counters.lowWater, dropped: 0, fedUntil: this.fedUntil };
  }
}

function silence(out: Float32Array[], frames: number) { out[0].fill(0, 0, frames); out[1].fill(0, 0, frames); }
