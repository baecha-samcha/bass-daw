// 업로드 해시 Worker: bounded streaming(메모리), 메인 스레드 long task, 취소, 오류 전달, 재시작.
// 기대 hash 는 Node(node:crypto)로 같은 바이트를 독립 계산한다. Pi headless 수치이며 실기 값이 아니다.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { BASE } from './helpers.ts';

test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] } });

const MiB = 1024 * 1024;
const part = (k: number) => { const b = new Uint8Array(MiB); for (let i = 0; i < MiB; i++) b[i] = (i * 31 + k * 7 + (i >> 11)) & 255; return b; };
function oracle(totalMiB: number, chunkMiB: number) {
  const full = createHash('sha256'); const chunks: string[] = [];
  for (let c = 0; c < totalMiB / chunkMiB; c++) { const h = createHash('sha256'); for (let i = 0; i < chunkMiB; i++) { const p = part(c * chunkMiB + i); full.update(p); h.update(p); } chunks.push(h.digest('hex')); }
  return { hash: full.digest('hex'), chunkHashes: chunks };
}
/** 페이지 안에서 같은 패턴의 Blob 생성(1MiB part 를 이어 붙임) */
const makeBlob = (totalMiB: number) => `(() => { const parts = []; for (let k = 0; k < ${totalMiB}; k++) { const b = new Uint8Array(${MiB}); for (let i = 0; i < ${MiB}; i++) b[i] = (i * 31 + k * 7 + (i >> 11)) & 255; parts.push(b); } return new Blob(parts); })()`;

test('hash worker: correct hashes, zero main-thread long tasks, bounded worker memory; main-thread control shows long tasks', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(BASE);
  await page.waitForFunction(() => !!(window as unknown as { __bassdaw?: unknown }).__bassdaw);
  const TOTAL = 128, CHUNK = 8;
  const r = await page.evaluate(async ({ src, chunk }) => {
    const w = window as unknown as { __bassdaw: { hasher: { hash(b: Blob, c: number, s?: AbortSignal, p?: (d: number, t: number) => void): Promise<{ hash: string; chunkHashes: string[]; maxHeld: number }> }; mainThreadHash(b: Blob, c: number): Promise<{ hash: string }> } };
    const blob = (0, eval)(src) as Blob;
    const long: number[] = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); });
    po.observe({ type: 'longtask' });
    await new Promise((r) => setTimeout(r, 300)); long.length = 0; // Blob 생성 등 준비 작업의 long task 제외
    const mem: number[] = [];
    const t0 = performance.now();
    let measuring: Promise<void> | null = null;
    const out = await w.__bassdaw.hasher.hash(blob, chunk * 1024 * 1024, undefined, (d, t) => {
      if (!measuring && d >= t / 2) measuring = (performance as unknown as { measureUserAgentSpecificMemory(): Promise<{ breakdown: { bytes: number; attribution: { scope: string }[] }[] }> }).measureUserAgentSpecificMemory()
        .then((m) => { mem.push(m.breakdown.filter((b) => b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')).reduce((a, b) => a + b.bytes, 0)); }).catch(() => undefined);
    });
    const workerMs = performance.now() - t0;
    await measuring;
    await new Promise((r) => setTimeout(r, 300));
    const workerLong = [...long]; long.length = 0;
    // 대조군: 같은 스트리밍 해시를 메인 스레드에서(16MiB 만)
    const small = blob.slice(0, 16 * 1024 * 1024);
    await w.__bassdaw.mainThreadHash(small, chunk * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 300));
    po.disconnect();
    return { out, workerMs, workerLong, mainLong: [...long], workerMem: mem };
  }, { src: makeBlob(TOTAL), chunk: CHUNK });
  const want = oracle(TOTAL, CHUNK);
  expect(r.out.hash).toBe(want.hash);
  expect(r.out.chunkHashes).toEqual(want.chunkHashes);
  expect(r.out.maxHeld).toBe(CHUNK * MiB); // 한 번에 chunk 하나만 보유
  console.log(JSON.stringify({ totalMiB: TOTAL, workerMs: Math.round(r.workerMs), MiBps: +(TOTAL / (r.workerMs / 1000)).toFixed(1), workerLongTasks: r.workerLong, mainThreadControlLongTasks: r.mainLong.map(Math.round), workerHeapBytesMid: r.workerMem }));
  expect(r.workerLong).toEqual([]);                       // worker 해시 중 메인 스레드 long task 0
  expect(r.mainLong.length).toBeGreaterThan(0);           // 측정이 동작함을 대조군으로 확인
  if (r.workerMem.length) expect(r.workerMem[0]).toBeLessThan(48 * MiB); // 128MiB 파일을 통째로 복사하지 않음
});

test('hash worker: cancel, error propagation, crash → restart and retry', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  await page.waitForFunction(() => !!(window as unknown as { __bassdaw?: unknown }).__bassdaw);
  const r = await page.evaluate(async (src) => {
    type H = { hash(b: Blob | Uint8Array, c: number, s?: AbortSignal, p?: (d: number, t: number) => void): Promise<{ hash: string }>; crash(): void; restarts: number };
    const h = (window as unknown as { __bassdaw: { hasher: H } }).__bassdaw.hasher;
    const blob = (0, eval)(src) as Blob;
    // 취소
    const ac = new AbortController();
    const t0 = performance.now();
    const cancelled = await h.hash(blob, 4 * 1024 * 1024, ac.signal, (d) => { if (d >= 8 * 1024 * 1024) ac.abort(); }).then(() => 'resolved', (e: Error) => e.message);
    const cancelMs = performance.now() - t0;
    // 취소 후에도 같은 worker 로 정상 동작
    const after = await h.hash(new Uint8Array([1, 2, 3]), 1024);
    // 오류 전달
    const err = await h.hash(new Uint8Array([1]), 0).then(() => 'resolved', (e: Error) => e.message);
    // crash → 재시작 후 같은 작업 재시도
    const before = h.restarts;
    let crashed = false;
    const re = await h.hash(blob, 4 * 1024 * 1024, undefined, (d) => { if (!crashed && d >= 8 * 1024 * 1024) { crashed = true; h.crash(); } });
    return { cancelled, cancelMs, after: after.hash, err, re: re.hash, restarts: h.restarts - before };
  }, makeBlob(64));
  expect(r.cancelled).toMatch(/CANCELLED/);
  expect(r.cancelMs).toBeLessThan(15_000);
  expect(r.after).toBe(createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'));
  expect(r.err).toMatch(/HASH_ERROR: bad chunkBytes/);
  expect(r.restarts).toBe(1);
  expect(r.re).toBe(oracle(64, 4).hash);
});
