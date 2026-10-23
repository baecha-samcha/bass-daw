import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE = 'http://localhost:4173/';
export const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export async function persistent(dir?: string): Promise<{ ctx: BrowserContext; dir: string }> {
  const d = dir ?? mkdtempSync(join(process.env.PW_PROFILE_ROOT ?? tmpdir(), 'bassdaw-'));
  const ctx = await chromium.launchPersistentContext(d, { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: launchArgs, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  return { ctx, dir: d };
}

export async function newProject(page: Page, title: string) {
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill(title);
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByLabel('프로젝트 제목').waitFor();
}

export async function waitSaved(page: Page) {
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('[data-testid=save-status]')?.textContent ?? ''), null, { timeout: 15_000 });
}
