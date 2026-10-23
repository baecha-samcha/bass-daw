// MVP-8(외부 계정 불필요 부분): 반복 사용 시 메인 스레드 JS heap 증가 검사(Pi headless, CDP).
// 05 의 기준(30분 지속 증가 10MiB 초과 → leak 조사)을 짧은 반복으로 근사한다. 실기 30분 측정을 대체하지 않는다.
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { BASE, waitSaved } from './helpers.ts';

test('heap does not grow across repeated open → play → stop → mixer → export → close cycles', async ({ page }) => {
  test.setTimeout(600_000);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(300); await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Leak check');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  for (const b of ['+ Bass', '+ Keys', '+ Drums']) await page.getByRole('button', { name: b }).click();
  await page.waitForTimeout(2500); await waitSaved(page);
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '엔진 진단', exact: true }).click();
  await expect(page.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 30_000 });
  await page.getByRole('button', { name: '프로젝트 목록' }).click();
  const samples: number[] = [];
  const CYCLES = 12;
  for (let i = 0; i < CYCLES; i++) {
    await page.getByRole('button', { name: 'Leak check 열기' }).click();
    await page.getByLabel('프로젝트 제목', { exact: true }).waitFor();
    await page.getByRole('button', { name: '재생', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '정지', exact: true }).click();
    await page.getByRole('tab', { name: '믹서', exact: true }).click();
    await page.waitForTimeout(300);
    if (i % 4 === 0) {
      await page.getByRole('tab', { name: '내보내기', exact: true }).click();
      const dl = page.waitForEvent('download', { timeout: 120_000 });
      await page.getByRole('button', { name: 'WAV 렌더' }).click();
      await dl;
    }
    await page.getByRole('tab', { name: '엔진 진단', exact: true }).click();
    await page.getByRole('button', { name: '프로젝트 목록' }).click();
    samples.push(await heap());
  }
  const MiB = 1024 * 1024;
  const warm = samples.slice(2); // 처음 2회는 캐시 warmup
  const growth = warm[warm.length - 1] - warm[0];
  // 단순 선형 추세(최소제곱 기울기 × 구간)로 일시 변동과 지속 증가를 구분
  const n = warm.length, xs = warm.map((_, i) => i), mx = (n - 1) / 2, my = warm.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (warm[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const trend = slope * (n - 1);
  mkdirSync('tests/artifacts/perf', { recursive: true });
  writeFileSync('tests/artifacts/perf/heap-cycles.json', JSON.stringify({ env: 'Pi headless Chromium', cycles: CYCLES, samplesMiB: samples.map((x) => +(x / MiB).toFixed(2)), growthMiB: +(growth / MiB).toFixed(2), trendMiB: +(trend / MiB).toFixed(2) }, null, 2));
  console.log('heap MiB', samples.map((x) => (x / MiB).toFixed(1)).join(' '), 'trend', (trend / MiB).toFixed(2));
  expect(trend).toBeLessThan(10 * MiB);
  expect(growth).toBeLessThan(10 * MiB);
});
