import { describe, it, expect } from 'vitest';
import { compilePlan, RenderCore, Scheduler, WorkletRuntime, createRingBuffer, RingProducer, RingConsumer, EngineStateMachine, SLOT_LOCATE, type Slot, type GraphPlan } from '@bass-daw/audio-engine';
import { Builder, impulse, dc, onsets, SR } from '../../../tests/fixtures/engine.ts';
import { oracleFrame } from '../../../tests/fixtures/oracle.ts';
import { rng } from '../../../tests/fixtures/ids.ts';

const info = (b: Builder) => (h: string) => { const p = b.pcm.get(h); return p ? { sampleRate: p.sampleRate, channels: 1 } : null; };

function renderOffline(b: Builder, frames: number, blocks: number[] = [128]): Float32Array[] {
  const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
  if (!plan.ok) throw new Error(plan.message);
  const max = Math.max(...blocks);
  const core = new RenderCore(plan.graph, b.pcm, { maxBlock: max, polyphony: 64 });
  core.setEvents(plan.events); core.locate(0, true);
  const out = [new Float32Array(frames), new Float32Array(frames)];
  const tmp = [new Float32Array(max), new Float32Array(max)];
  let pos = 0, k = 0;
  while (pos < frames) {
    const n = Math.min(blocks[k++ % blocks.length], frames - pos);
    core.renderBlock(tmp, n);
    out[0].set(tmp[0].subarray(0, n), pos); out[1].set(tmp[1].subarray(0, n), pos);
    pos += n;
  }
  return out;
}

const F01 = [{ tick: 0, bpm: 120 }, { tick: 3840, bpm: 90 }, { tick: 7680, bpm: 173 }];
const F01_TICKS = [0, 1, 959, 960, 961, 3839, 3840, 3841, 7679, 7680, 7681, 9000];

describe('A01 tempo impulse onset ≤1 frame (independent oracle), block sizes 64/128/256/512', () => {
  for (const blocks of [[64], [128], [256], [512], [64, 512, 128, 256, 100, 37]]) {
    it(`blocks ${blocks.join(',')}`, () => {
      const b = new Builder(F01.map((t) => ({ ...t, transition: 'step' as const })));
      b.midiTrack('imp', impulse(), F01_TICKS.map((t, i) => ({ tick: t, dur: 1, pitch: 60 + (i % 2) })), { lengthTicks: 3840 * 4 });
      const out = renderOffline(b, oracleFrame(F01, 9100, SR), blocks);
      const got = onsets(out[0]);
      const expected = F01_TICKS.map((t) => oracleFrame(F01, t, SR));
      expect(got.length).toBe(expected.length);
      got.forEach((g, i) => expect(Math.abs(g - expected[i])).toBeLessThanOrEqual(1));
      // 정수 Tick 양자화 손실(0)과 frame 변환 오차를 분리 보고
      const maxErr = Math.max(...got.map((g, i) => Math.abs(g - expected[i])));
      expect(maxErr).toBeLessThanOrEqual(1);
    });
  }
});

describe('A02 same-frame ordering and sustain', () => {
  it('noteOff before noteOn on the same frame (retrigger keeps sounding)', () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR, 0.5), [{ tick: 0, dur: 960 }, { tick: 960, dur: 960 }], { loop: [100, 40000] });
    const out = renderOffline(b, SR * 1.5);
    // 960 tick=24000 frame: 이전 voice 는 release(1ms), 새 voice 는 즉시 0.5 → 합이 0.5 이상, 중단 없음
    expect(out[0][24000]).toBeGreaterThan(0.45);
    expect(out[0][24000 + 200]).toBeCloseTo(0.5, 3);
    expect(out[0][48000 + 200]).toBe(0);
  });
  it('CC64 sustain holds after noteOff until pedal release; channel-scoped', () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR * 2, 0.5), [{ tick: 0, dur: 480, channel: 0 }, { tick: 0, dur: 480, channel: 1, pitch: 61 }], { loop: [100, 90000], cc: [{ tick: 0, controller: 64, value: 127, channel: 0 }, { tick: 1920, controller: 64, value: 0, channel: 0 }] });
    const out = renderOffline(b, SR * 2);
    // 480 tick = 12000 frame: ch1 voice 해제, ch0 은 sustain 으로 유지(0.5)
    expect(out[0][20000]).toBeCloseTo(0.5, 3);
    // pedal up at 1920 tick = 48000 frame → release 1ms 후 무음
    expect(out[0][48000 + 200]).toBe(0);
  });
});

describe('sampler voice limits', () => {
  it('voice stealing caps polyphony and is counted', () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR, 0.01), Array.from({ length: 80 }, (_, i) => ({ tick: i, dur: 3000, pitch: 40 + (i % 40) })), { loop: [10, 40000] });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    if (!plan.ok) throw new Error();
    const core = new RenderCore(plan.graph, b.pcm, { maxBlock: 128, polyphony: 32 });
    core.setEvents(plan.events); core.locate(0, true);
    const o = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 40; i++) core.renderBlock(o, 128);
    expect(core.counters.voiceSteals).toBeGreaterThan(0);
    expect(core.activeVoices).toBeLessThanOrEqual(32 + 8);
  });
});

// ---------- 실시간 경로 시뮬레이션: Scheduler → SAB ring → WorkletRuntime ----------
function simulate(b: Builder, opts: { frames: number; blocks: number[]; ringCap?: number; feedEvery?: number; lookahead?: number; loop?: boolean; startTf?: number; shared?: boolean }) {
  const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
  if (!plan.ok) throw new Error(plan.message);
  const graph: GraphPlan = plan.graph;
  const core = new RenderCore(graph, b.pcm, { maxBlock: 1024, polyphony: 64 });
  const rt = new WorkletRuntime(core, 256);
  rt.setTable(0, plan.events);
  const buf = createRingBuffer(opts.ringCap ?? 65536, opts.shared ?? true);
  const prod = new RingProducer(buf), cons = new RingConsumer(buf);
  rt.control('play', 1, opts.startTf ?? 0);
  const ack = rt.notices.find((n) => n.type === 'ack')!;
  const sched = new Scheduler(plan.events, graph.loop, opts.startTf ?? 0, (ack as { anchorCf: number }).anchorCf, 1, 0);
  const out = [new Float32Array(opts.frames), new Float32Array(opts.frames)];
  const tmp = [new Float32Array(1024), new Float32Array(1024)];
  let pos = 0, k = 0, sinceFeed = Infinity; const look = opts.lookahead ?? Math.round(SR * 0.25);
  let retries = 0;
  while (pos < opts.frames) {
    if (sinceFeed >= (opts.feedEvery ?? 1200)) { const before = prod.size(); sched.fill(rt.contextFrame + look, (s) => { const ok = prod.push(s); if (!ok) retries++; return ok; }); prod.setWatermark(1, sched.fedUntil); sinceFeed = 0; void before; }
    const n = Math.min(opts.blocks[k++ % opts.blocks.length], opts.frames - pos);
    rt.watermark(cons.watermarkGeneration(), cons.watermarkFrame(rt.contextFrame));
    rt.process(tmp, n, () => cons.peekFrame(), (s: Slot) => cons.pop(s));
    out[0].set(tmp[0].subarray(0, n), pos); out[1].set(tmp[1].subarray(0, n), pos);
    pos += n; sinceFeed += n;
  }
  return { out, rt, retries, anchor: (ack as { anchorCf: number }).anchorCf };
}

describe('A03 block / loop boundary: no missing or duplicate notes', () => {
  it('loop [1 bar, 3 bars) with irregular blocks', () => {
    const b = new Builder();
    // 박자마다 impulse, 루프 경계(3840, 11520)에 정확히 놓인 노트 포함
    const ticks = Array.from({ length: 16 }, (_, i) => i * 960);
    b.midiTrack('imp', impulse(), ticks.map((t) => ({ tick: t, dur: 10 })), { lengthTicks: 3840 * 4 });
    b.run({ type: 'SetLoop', enabled: true, startTick: 3840, endTick: 11520 });
    const frames = SR * 12;
    const { out, rt, anchor } = simulate(b, { frames, blocks: [128, 64, 512, 37, 256, 200] });
    const got = onsets(out[0]);
    // 기대: 0..3 박(0..2s) 후 [1,3) 마디(8박=4초) 반복
    const expected: number[] = [];
    const beat = SR / 2;
    for (let i = 0; i < 4; i++) expected.push(anchor + i * beat);
    let start = anchor + 2 * SR;
    while (start < frames) { for (let i = 0; i < 8; i++) { const f = start + i * beat; if (f < frames) expected.push(f); } start += 4 * SR; }
    expect(got).toEqual(expected);
    expect(rt.counters.late).toBe(0);
    expect(rt.counters.underruns).toBe(0);
  });
});

describe('A05 generation & queue', () => {
  it('stale generation events are never executed after seek', () => {
    const b = new Builder();
    b.midiTrack('imp', impulse(), Array.from({ length: 40 }, (_, i) => ({ tick: i * 240, dur: 10 })), { lengthTicks: 3840 * 4 });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    if (!plan.ok) throw new Error();
    const core = new RenderCore(plan.graph, b.pcm, { maxBlock: 128, polyphony: 64 });
    const rt = new WorkletRuntime(core, 128);
    rt.setTable(0, plan.events);
    const buf = createRingBuffer(4096); const prod = new RingProducer(buf), cons = new RingConsumer(buf);
    rt.control('play', 1, 0);
    const s1 = new Scheduler(plan.events, plan.graph.loop, 0, 128, 1);
    s1.fill(SR * 2, (s) => prod.push(s)); prod.setWatermark(1, s1.fedUntil); // 2초치 공급
    const o = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 10; i++) rt.watermark(cons.watermarkGeneration(), cons.watermarkFrame(rt.contextFrame)), rt.process(o, 128, () => cons.peekFrame(), (s) => cons.pop(s));
    // seek: 새 generation. 큐에 남은 gen1 slot 은 실행되면 안 된다
    rt.control('seek', 2, 0);
    let heard = 0;
    for (let i = 0; i < 400; i++) { rt.process(o, 128, () => cons.peekFrame(), (s) => cons.pop(s)); heard += onsets(o[0]).length; }
    expect(heard).toBe(0);
    expect(rt.counters.stale).toBeGreaterThan(0);
  });
  it('overflowing ring: producer retries, nothing dropped, order kept', () => {
    const b = new Builder();
    const notes = Array.from({ length: 300 }, (_, i) => ({ tick: i * 30, dur: 5, pitch: 40 + (i % 60) }));
    b.midiTrack('imp', impulse(), notes, { lengthTicks: 3840 * 4 });
    const { out, rt, retries } = simulate(b, { frames: Math.round(SR * 5.2), blocks: [128], ringCap: 64, feedEvery: 128, lookahead: SR });
    expect(retries).toBeGreaterThan(0);
    expect(onsets(out[0]).length).toBe(300);
    expect(rt.counters.late).toBe(0);
  });
  it('MessagePort-equivalent (non-shared buffer) path has the same contract', () => {
    const b = new Builder();
    b.midiTrack('imp', impulse(), [0, 960, 1920].map((t) => ({ tick: t, dur: 10 })), { lengthTicks: 3840 });
    const { out } = simulate(b, { frames: SR * 2, blocks: [128], shared: false });
    expect(onsets(out[0]).length).toBe(3);
  });
  it('ring cursors wrap modulo 2^32', () => {
    const buf = createRingBuffer(8); const p = new RingProducer(buf), c = new RingConsumer(buf);
    p.setCursorsForTest(0xfffffffe);
    for (let i = 0; i < 5; i++) expect(p.push({ type: 1, generation: 1, sequence: i, payloadIndex: i, frame: i })).toBe(true);
    const s: Slot = { type: 0, generation: 0, sequence: 0, payloadIndex: 0, frame: 0 };
    const got: number[] = []; while (c.pop(s)) got.push(s.payloadIndex);
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });
  it('underrun (starved queue) panics and stops instead of leaving notes hanging', () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR, 0.5), [{ tick: 0, dur: 9600 }], { loop: [10, 40000] });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    if (!plan.ok) throw new Error();
    const core = new RenderCore(plan.graph, b.pcm, { maxBlock: 128, polyphony: 64 });
    const rt = new WorkletRuntime(core, 128); rt.setTable(0, plan.events);
    const buf = createRingBuffer(1024); const prod = new RingProducer(buf), cons = new RingConsumer(buf);
    rt.control('play', 1, 0);
    const sc = new Scheduler(plan.events, plan.graph.loop, 0, 128, 1); sc.fill(128 + 4800, (s) => prod.push(s)); prod.setWatermark(1, sc.fedUntil); // 100ms 만 공급 후 main thread 정지 가정
    const o = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 100; i++) rt.watermark(cons.watermarkGeneration(), cons.watermarkFrame(rt.contextFrame)), rt.process(o, 128, () => cons.peekFrame(), (s) => cons.pop(s));
    expect(rt.counters.underruns).toBe(1);
    expect(rt.state).toBe('idle');
    expect(core.activeVoices).toBe(0);
    expect(rt.notices.some((n) => n.type === 'underrun')).toBe(true);
  });
});

describe('A04 transport state & voice release', () => {
  it('state machine transitions per 01 §4', () => {
    const m = new EngineStateMachine();
    for (const s of ['preparing', 'ready', 'playing', 'paused', 'playing', 'suspended', 'paused', 'ready', 'closed'] as const) m.to(s);
    const m2 = new EngineStateMachine();
    expect(() => m2.to('playing')).toThrow(/INVALID_TRANSITION/);
    const m3 = new EngineStateMachine(); m3.to('preparing'); m3.to('ready'); m3.to('closed');
    expect(() => m3.to('ready')).toThrow();
  });
  it('pause / stop / seek release all voices within 5ms ramp', () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR, 0.5), [{ tick: 0, dur: 9600 }], { loop: [10, 40000], releaseMs: 2000 });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    if (!plan.ok) throw new Error();
    for (const op of ['pause', 'stop', 'seek'] as const) {
      const core = new RenderCore(plan.graph, b.pcm, { maxBlock: 128, polyphony: 64 });
      const rt = new WorkletRuntime(core, 0); rt.setTable(0, plan.events);
      const buf = createRingBuffer(1024); const prod = new RingProducer(buf), cons = new RingConsumer(buf);
      rt.control('play', 1, 0);
      const sch = new Scheduler(plan.events, plan.graph.loop, 0, 0, 1);
      const o = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < 20; i++) { sch.fill(rt.contextFrame + 12000, (s) => prod.push(s)); prod.setWatermark(1, sch.fedUntil); rt.watermark(cons.watermarkGeneration(), cons.watermarkFrame(rt.contextFrame)); rt.process(o, 128, () => cons.peekFrame(), (s) => cons.pop(s)); }
      expect(core.activeVoices).toBe(1);
      rt.control(op, 2, op === 'seek' ? 48000 : 0);
      // idle 상태에서는 출력 무음; voice 는 ramp 상태로 회수
      const none = new Int32Array(0);
      core.renderBlock(o, 128, none, 0); core.renderBlock(o, 128, none, 0); core.renderBlock(o, 128, none, 0);
      expect(core.activeVoices).toBe(0);
    }
  });
});

describe('determinism helper', () => {
  it('rng is seeded', () => { const r = rng(5); const a = [r(), r()]; const r2 = rng(5); expect([r2(), r2()]).toEqual(a); });
});

export { SLOT_LOCATE };
