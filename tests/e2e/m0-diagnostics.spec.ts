import { test, expect } from '@playwright/test';
import { persistent, BASE } from './helpers.ts';
import { readFileSync } from 'node:fs';

test('MVP-0: diagnostics — context, freeze injection, 128MiB store → browser restart → restore, mic capture, JSON report', async () => {
  test.setTimeout(600_000);
  const { ctx, dir } = await persistent();
  const page = await ctx.newPage();
  await page.goto(`${BASE}#/diagnostics`);
  await page.getByRole('button', { name: '컨텍스트 시작 (48kHz 요청)' }).click();
  await expect(page.getByText(/actual 48000Hz/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '재생', exact: true }).click();
  await expect(page.getByText(/state playing/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '100ms 정지' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '500ms 정지' }).click();
  await page.waitForTimeout(1500);
  const freeze = await page.locator('pre').first().innerText();
  console.log('freeze results', freeze);
  await page.getByRole('button', { name: 'context suspend' }).click();
  await page.getByRole('button', { name: 'context resume' }).click();
  await page.getByRole('button', { name: '저장 테스트 (OPFS, 불가 시 IDB)' }).click();
  await expect(page.getByText(/verify OK/)).toBeVisible({ timeout: 300_000 });
  await page.getByRole('button', { name: '권한 요청 후 3초 녹음' }).click();
  await expect(page.getByText(/"seconds"/)).toBeVisible({ timeout: 20_000 });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 보고서 다운로드' }).click();
  await (await dl).saveAs('tests/artifacts/diag-report-headless.json');
  const report = JSON.parse(readFileSync('tests/artifacts/diag-report-headless.json', 'utf8'));
  expect(report.audio.sampleRate).toBe(48000);
  expect(report.storage.verifyHash).toBe(report.storage.hash);
  expect(report.storage.bytes).toBe(128 * 1024 * 1024);
  await ctx.close();
  // 브라우저 재시작 → 복구 확인
  const again = await persistent(dir);
  const p2 = again.ctx.pages()[0] ?? await again.ctx.newPage();
  await p2.goto(`${BASE}#/diagnostics`);
  await p2.getByRole('button', { name: '재시작 후 복구 확인' }).click();
  await expect(p2.getByText(/restart check: OK/)).toBeVisible({ timeout: 300_000 });
  // IDB fallback 강제
  await p2.getByRole('button', { name: 'IDB Blob fallback 강제' }).click();
  await expect(p2.getByText(/"backend": "idb"/)).toBeVisible({ timeout: 300_000 });
  await expect(p2.getByText(/verify OK/)).toBeVisible();
  await p2.getByRole('button', { name: '진단 데이터만 정리' }).click();
  await expect(p2.getByText(/진단 데이터\(diag\/\*\)만 삭제/)).toBeVisible();
  await again.ctx.close();
});
