// 큐 공급 worker: 25ms 주기로 lookahead(250ms)까지 이벤트를 SAB ring 또는 MessagePort batch 로 공급한다(01 §5).
// worker timer 는 공급용일 뿐 실시간 시계는 AudioContext frame 이다.
import { Scheduler, RingProducer, encodeBatch, type EventTable, type LoopRt, type Slot, type RuntimeNotice } from '@bass-daw/audio-engine';

let ring: RingProducer | null = null;
let status: Float64Array | null = null;
let port: MessagePort | null = null;
let sr = 48000; let lookahead = 0.25; let period = 25;
let table: EventTable | null = null; let planVersion = 0; let loop: LoopRt = { enabled: false, startFrame: 0, endFrame: 0 };
let sched: Scheduler | null = null;
let lastClock = 0; let lastClockAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let stats = { fills: 0, retries: 0, maxFillMs: 0 };

function currentFrame(): number {
  if (status) return status[0];
  return lastClock + ((performance.now() - lastClockAt) / 1000) * sr;
}

function tick() {
  if (!sched) return;
  const t0 = performance.now();
  const until = Math.floor(currentFrame() + lookahead * sr);
  if (ring) {
    sched.fill(until, (s) => { const ok = ring!.push(s); if (!ok) stats.retries++; return ok; });
    ring.setWatermark(sched.generation, sched.fedUntil);
  } else if (port) {
    const slots: Slot[] = [];
    sched.fill(until, (s) => { slots.push({ ...s }); return true; });
    const buf = encodeBatch(slots);
    port.postMessage({ type: 'slots', buffer: buf, watermark: { generation: sched.generation, frame: sched.fedUntil } }, [buf]);
  }
  stats.fills++; stats.maxFillMs = Math.max(stats.maxFillMs, performance.now() - t0);
}

function onNotice(n: RuntimeNotice) {
  if (n.type === 'ack') {
    if (n.op === 'play' && table) {
      sched = new Scheduler(table, loop, n.timelineFrame, n.anchorCf, n.generation, planVersion);
      tick();
      if (!timer) timer = setInterval(tick, period);
    } else { sched = null; }
  } else if (n.type === 'underrun') { sched = null; }
  else if (n.type === 'plan' && pendingReplace && n.planVersion === pendingReplace.planVersion) {
    sched?.replaceTable(pendingReplace.table, pendingReplace.planVersion, pendingReplace.kill);
    table = pendingReplace.table; planVersion = pendingReplace.planVersion; pendingReplace = null;
  }
}
let pendingReplace: { table: EventTable; planVersion: number; kill: number[] } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      ring = m.ring ? new RingProducer(m.ring) : null;
      status = m.status ? new Float64Array(m.status) : null;
      sr = m.sampleRate; lookahead = m.lookahead ?? 0.25; period = m.period ?? 25;
      port = m.port ?? null;
      if (port) port.onmessage = (ev) => { if (ev.data.type === 'notice') onNotice(ev.data.notice); else if (ev.data.type === 'clock') { lastClock = ev.data.contextFrame; lastClockAt = performance.now(); } };
      break;
    case 'table':
      // 정지 중 교체
      table = m.table; planVersion = m.planVersion; loop = m.loop;
      break;
    case 'replace':
      // 재생 중 교체: worklet 이 표를 받았다는 'plan' notice 이후 fedUntil 부터 새 표로 공급
      pendingReplace = { table: m.table, planVersion: m.planVersion, kill: m.kill }; loop = m.loop;
      if (!sched) { table = m.table; planVersion = m.planVersion; pendingReplace = null; }
      break;
    case 'stats':
      (self as unknown as Worker).postMessage({ type: 'stats', stats, fedUntil: sched?.fedUntil ?? null });
      break;
  }
};
