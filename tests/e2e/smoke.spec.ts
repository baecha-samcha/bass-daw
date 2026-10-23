import { test, expect } from '@playwright/test';

test('diagnostics: isolation, worklet, OPFS detected', async ({ page }) => {
  await page.goto('/#/diagnostics');
  const table = page.getByTestId('features');
  await expect(table).toContainText('crossOriginIsolated');
  await page.waitForTimeout(1500);
  const text = await table.innerText();
  const val = (k: string) => text.split('\n').find((l) => l.startsWith(k))?.split('\t')[1]?.trim();
  console.log(text);
  expect(val('crossOriginIsolated')).toBe('true');
  expect(val('AudioWorklet')).toBe('true');
  expect(val('OPFS createWritable')).toBe('true');
  await page.screenshot({ path: 'tests/artifacts/diagnostics.png', fullPage: true });
});

test('editor boots, tracks added, audio plays', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.getByLabel('새 프로젝트 제목').fill('Smoke');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  for (const b of ['+ Bass TAB', '+ Guitar TAB', '+ Keys', '+ Drums']) { await page.getByRole('button', { name: b }).click(); await page.waitForTimeout(300); }
  await expect(page.locator('.track-head')).toHaveCount(4);
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(page.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 20_000 });
  await page.getByRole('button', { name: '재생' }).click();
  await expect(page.getByTestId('engine-state')).toHaveText('playing', { timeout: 10_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/artifacts/editor.png' });
  console.log('errors', errors);
  expect(errors).toEqual([]);
});
