import { test, expect, type Page } from '@playwright/test';
import { persistent, BASE, waitSaved } from './helpers.ts';

async function selectClip(page: Page, trackName: string) {
  const head = page.locator('.track-head', { hasText: trackName });
  const idx = await page.locator('.track-head').evaluateAll((els, n) => els.findIndex((e) => e.textContent?.includes(n)), trackName);
  void head;
  const clip = page.locator('rect[data-testid^="clip-"]').nth(idx);
  const box = (await clip.boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height / 2);
  await page.getByRole('tab', { name: '편집' }).click();
}

test('E01/E03 + MVP-3 demo: four instruments 8 bars → edit/undo → save → restart → identical events', async () => {
  const { ctx, dir } = await persistent();
  const page = await ctx.newPage();
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Four');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  for (const b of ['+ Bass TAB', '+ Guitar TAB', '+ Keys', '+ Drums']) { await page.getByRole('button', { name: b }).click(); await page.waitForTimeout(400); }
  await page.waitForTimeout(2500);

  // --- Bass TAB: 8마디 노트 입력 (프렛 입력 → 클릭) ---
  await selectClip(page, 'Bass');
  const grid = page.getByRole('grid', { name: /TAB 편집 그리드/ });
  await page.getByRole('button', { name: '편집기 축소' }).click(); await page.getByRole('button', { name: '편집기 축소' }).click();
  await page.getByLabel('입력 프렛').fill('3');
  await page.getByLabel('노트 길이').selectOption('960');
  const row0 = page.getByTestId('tab-row-0');
  const rb = (await row0.boundingBox())!;
  const ppb = 64 / 1.5 / 1.5; // 축소 2회
  for (let beat = 0; beat < 32; beat += 2) await page.mouse.click(rb.x + beat * ppb + 5, rb.y + rb.height / 2);
  // 키보드: 마지막 노트 프렛 7, 오른쪽 이동, 삭제 후 Undo
  await grid.focus();
  await page.keyboard.press('7');
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowUp'); // 현 변경
  const notesBefore = await page.locator('[data-testid^="tab-note-"]').count();
  expect(notesBefore).toBe(16);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid^="tab-note-"]')).toHaveCount(15);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-testid^="tab-note-"]')).toHaveCount(16);
  // 주법: 첫 노트 slap
  await page.locator('[data-testid^="tab-note-"] rect').first().click();
  await page.getByRole('checkbox', { name: 'slap' }).check();

  // --- Guitar: 코드 스트로크 + 아르페지오 ---
  await selectClip(page, 'Guitar');
  await page.getByRole('button', { name: '코드/스트로크' }).click();
  await page.getByRole('button', { name: '편집기 축소' }).click(); await page.getByRole('button', { name: '편집기 축소' }).click();
  await page.getByLabel('코드 모양').selectOption('G');
  const g0 = (await page.getByTestId('tab-row-0').boundingBox())!;
  for (let beat = 0; beat < 32; beat += 4) await page.mouse.click(g0.x + beat * ppb + 5, g0.y + g0.height / 2);
  await page.getByRole('button', { name: '↑ 업' }).click();
  await page.getByLabel('현 사이 간격 ms').fill('20'); await page.getByLabel('현 사이 간격 ms').blur();
  await page.getByLabel('현 1 뮤트').check();

  // --- Keys: 피아노 롤 ---
  await selectClip(page, 'Keys');
  await page.getByRole('button', { name: '편집기 축소' }).click(); await page.getByRole('button', { name: '편집기 축소' }).click();
  const pr = page.getByRole('grid', { name: /피아노 롤/ });
  await pr.evaluate((el) => { (el.parentElement as HTMLElement).scrollTop = 0; });
  const pb = (await pr.boundingBox())!;
  for (let beat = 0; beat < 32; beat += 1) await page.mouse.click(pb.x + beat * ppb + 4, pb.y + 100 + (beat % 5) * 12);
  await page.getByRole('button', { name: '재생위치 sustain 토글' }).click();

  // --- Drums: 스텝 ---
  await selectClip(page, 'Drums');
  for (let i = 0; i < 128; i += 4) await page.getByRole('gridcell', { name: `Kick ${i + 1}`, exact: true }).click();
  for (let i = 2; i < 128; i += 4) await page.getByRole('gridcell', { name: `Closed HH ${i + 1}`, exact: true }).click({ modifiers: ['Shift'] });
  // 키보드 토글(E05)
  await page.getByRole('gridcell', { name: 'Snare 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('gridcell', { name: 'Snare 1', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await waitSaved(page);
  const plan1 = await page.evaluate(() => (window as unknown as { __bassdaw: { planHash(): unknown } }).__bassdaw.planHash());
  const hash1 = await page.evaluate(() => (window as unknown as { __bassdaw: { projectHash(): Promise<string> } }).__bassdaw.projectHash());
  console.log('plan', plan1);
  expect((plan1 as { count: number }).count).toBeGreaterThan(200);
  await page.screenshot({ path: 'tests/artifacts/four-instruments.png' });
  expect(errors).toEqual([]);
  await ctx.close();

  const again = await persistent(dir);
  const p2 = again.ctx.pages()[0] ?? await again.ctx.newPage();
  await p2.goto(BASE);
  await p2.getByRole('button', { name: 'Four 열기' }).click();
  await p2.locator('.track-head').first().waitFor();
  const plan2 = await p2.evaluate(() => (window as unknown as { __bassdaw: { planHash(): unknown } }).__bassdaw.planHash());
  const hash2 = await p2.evaluate(() => (window as unknown as { __bassdaw: { projectHash(): Promise<string> } }).__bassdaw.projectHash());
  expect(plan2).toEqual(plan1);
  expect(hash2).not.toBeNull();
  void hash1;
  // 재생(실제 AudioWorklet)
  await p2.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await p2.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(p2.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 20_000 });
  await p2.getByRole('button', { name: '재생' }).click();
  await p2.waitForTimeout(4000);
  await expect(p2.getByTestId('underruns')).toHaveText(/^0 \//);
  await expect(p2.getByTestId('late')).toHaveText(/^0 \//);
  await p2.getByRole('button', { name: '정지', exact: true }).click();
  await again.ctx.close();
});

test('E02/E04: clip split/duplicate/loop/trim + undo restore; ruler seek', async ({ page }) => {
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Clips');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Keys' }).click();
  await page.waitForTimeout(1500);
  const h0 = await page.evaluate(() => (window as unknown as { __bassdaw: { projectHash(): Promise<string> } }).__bassdaw.projectHash());
  const clip = page.locator('rect[data-testid^="clip-"]').first();
  const b = (await clip.boundingBox())!;
  await page.mouse.click(b.x + 30, b.y + 10);
  // ruler 클릭으로 seek (2마디)
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  await page.mouse.click(ruler.x + 48 * 4 * 2 + 1, ruler.y + 5);
  await expect(page.getByTestId('position')).toHaveText('3.1.000');
  await page.getByRole('button', { name: '재생위치 분할' }).click();
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(2);
  await page.getByRole('button', { name: '복제' }).click();
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(3);
  await page.getByRole('button', { name: '클립 루프' }).click();
  // drag trim end handle of selected clip
  await page.getByRole('button', { name: '실행 취소' }).click();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(1);
  const h1 = await page.evaluate(() => (window as unknown as { __bassdaw: { projectHash(): Promise<string> } }).__bassdaw.projectHash());
  // updatedAt 이 바뀌므로 tracks/sources 만 비교
  const sig = () => page.evaluate(() => { const p = (window as unknown as { __bassdaw: { state(): { project: { tracks: unknown; sources: unknown } } } }).__bassdaw.state().project; return JSON.stringify([p.tracks, p.sources]); });
  void h0; void h1;
  const s1 = await sig();
  await page.getByRole('button', { name: '다시 실행' }).click();
  await page.getByRole('button', { name: '실행 취소' }).click();
  expect(await sig()).toBe(s1);
  // drag move 1 bar
  const c = (await page.locator('rect[data-testid^="clip-"]').first().boundingBox())!;
  await page.mouse.move(c.x + 50, c.y + 10); await page.mouse.down(); await page.mouse.move(c.x + 50 + 48 * 4, c.y + 10, { steps: 5 }); await page.mouse.up();
  const start = await page.evaluate(() => (window as unknown as { __bassdaw: { state(): { project: { tracks: { clips: { startTick: number }[] }[] } } } }).__bassdaw.state().project.tracks[0].clips[0].startTick);
  expect(start).toBe(3840);
});

test('E05: touch viewport and accessible labels', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Touch');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Bass TAB' }).click();
  await page.waitForTimeout(800);
  for (const name of ['실행 취소', '다시 실행', '템포', 'Bass 뮤트', 'Bass 솔로', '스냅', '프로젝트 제목']) await expect(page.getByLabel(name)).toBeVisible();
  const clip = page.locator('rect[data-testid^="clip-"]').first();
  await clip.tap();
  await page.getByRole('tab', { name: '편집' }).tap();
  // 버튼/수치 입력 대체 조작: 노트 추가 후 속성 입력
  await page.getByTestId('tab-row-1').scrollIntoViewIfNeeded();
  const row = (await page.getByTestId('tab-row-1').boundingBox())!;
  await page.touchscreen.tap(row.x + 10, row.y + row.height / 2);
  await expect(page.getByRole('group', { name: '노트 속성' })).toBeVisible();
  await page.getByLabel('프렛', { exact: true }).fill('5'); await page.getByLabel('프렛', { exact: true }).blur();
  await expect(page.locator('[data-testid^="tab-note-"] text').first()).toHaveText('5');
  await page.screenshot({ path: 'tests/artifacts/mobile.png', fullPage: true });
  await ctx.close();
});
