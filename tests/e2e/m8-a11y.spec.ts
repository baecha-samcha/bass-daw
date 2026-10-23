// MVP-8(외부 계정 불필요 부분): 자동 접근성 검사(axe, WCAG 2.1 A/AA 규칙)와 키보드 전용 핵심 흐름.
// 자동 검사는 스크린리더 실사용 검증을 대체하지 않는다(실기 VoiceOver/TalkBack 은 BLOCKED).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { BASE, waitSaved } from './helpers.ts';

async function scan(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  mkdirSync('tests/artifacts/a11y', { recursive: true });
  writeFileSync(`tests/artifacts/a11y/${name}.json`, JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 10) })), null, 2));
  return r.violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('axe: home, editor panels, sync and plugin panels have no WCAG A/AA violations', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  const found: Record<string, string[]> = {};
  found.home = await scan(page, 'home');
  await page.getByLabel('새 프로젝트 제목').fill('A11y');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  for (const b of ['+ Bass', '+ Keys', '+ Drums']) await page.getByRole('button', { name: b }).click();
  await page.waitForTimeout(2000);
  found.editor = await scan(page, 'editor');
  for (const [tab, name] of [['믹서', 'mixer'], ['자동화', 'automation'], ['녹음/가져오기', 'record'], ['내보내기', 'export'], ['악보', 'score'], ['플러그인', 'plugins'], ['프로젝트 파일', 'files'], ['엔진 진단', 'engine']] as const) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    found[name] = await scan(page, name);
  }
  await page.goto(`${BASE}#/diagnostics`);
  await page.waitForTimeout(1000);
  found.diagnostics = await scan(page, 'diagnostics');
  console.log(JSON.stringify(found, null, 1));
  for (const [k, v] of Object.entries(found)) expect(v, k).toEqual([]);
});

test('keyboard only: create project, add track, play/stop, save, open tabs — focus always visible', async ({ page }) => {
  await page.goto(BASE);
  await page.keyboard.press('Tab');
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    reached = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') === '새 프로젝트 제목');
    if (!reached) await page.keyboard.press('Tab');
  }
  expect(reached).toBe(true);
  await page.keyboard.type('Keys only');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('새 프로젝트');
  await page.keyboard.press('Enter');
  await page.getByLabel('프로젝트 제목', { exact: true }).waitFor();
  // 트랙 추가 버튼까지 Tab 이동 후 Enter
  let onAdd = false;
  for (let i = 0; i < 60 && !onAdd; i++) { await page.keyboard.press('Tab'); onAdd = (await page.evaluate(() => document.activeElement?.textContent ?? '')).startsWith('+ Bass'); }
  expect(onAdd).toBe(true);
  // 포커스 표시가 실제로 보이는지(outline 또는 box-shadow)
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none'; });
  expect(ring).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.track-head')).toHaveCount(1);
  // 클립도 키보드로 선택 가능(트림 핸들은 포인터 전용, 키보드 대안 = 클립 도구막대)
  const clip = page.locator('rect[data-testid^="clip-"]').first();
  await clip.focus(); await page.keyboard.press('Enter');
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '복제' })).toBeVisible();
  await page.evaluate(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
  const projectDownload=page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  expect((await projectDownload).suggestedFilename()).toMatch(/\.dawbae$/);
  await waitSaved(page);
  // 탭 목록은 키보드로 열 수 있다
  const tab = page.getByRole('tab', { name: '믹서', exact: true });
  await tab.focus(); await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});
