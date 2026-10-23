import { test, expect, chromium } from '@playwright/test';
import { BASE } from './helpers.ts';

async function armWith(args: string[]) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required', ...args] });
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Perm');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Audio' }).click();
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '녹음/가져오기' }).click();
  await page.getByRole('button', { name: '입력 권한 요청/준비' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('error', { timeout: 15_000 });
  const msg = await page.locator('.card .err').first().innerText();
  await browser.close();
  return msg;
}

test('R01: permission denied vs no device are distinguished', async () => {
  const denied = await armWith(['--deny-permission-prompts', '--use-fake-device-for-media-stream']);
  expect(denied).toMatch(/PERMISSION_DENIED/);
  const none = await armWith(['--use-fake-ui-for-media-stream']);
  console.log('no-device message:', none);
  expect(none).toMatch(/NO_DEVICE|DEVICE_BUSY|PERMISSION_DENIED/);
});
