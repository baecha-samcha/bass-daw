// 베이스 악보 출력: 실제 브라우저(Chromium headless) 렌더링·인쇄(PDF) 레이아웃·편집기 흐름·원본 불변.
// PDF 는 Chromium 인쇄 경로(page.pdf, print media)로 만든다 = 브라우저 "PDF로 저장"과 같은 렌더 경로. poppler 로 검사.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BASE, waitSaved } from './helpers.ts';

const OUT = 'tests/artifacts/score';
mkdirSync(OUT, { recursive: true });
const CASES = ['four-both', 'five-tab', 'six-score', 'dropd-key', 'tech', 'unsupported', 'long'];
const texts = (page: Page, id: string) => page.getByTestId(`sheet-${id}`).evaluate((el) => [...el.querySelectorAll('svg text')].map((t) => t.textContent ?? ''));
const pdfPages = (file: string) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())![1]);
/** pdftotext 는 SVG 글자 간격 때문에 단어 사이 공백이 여러 개로 나온다 → 공백 정규화 */
const pdfText = (file: string, p?: number) => execFileSync('pdftotext', [...(p ? ['-f', String(p), '-l', String(p)] : []), '-layout', file, '-']).toString().replace(/\s+/g, ' ');

test('validation screen: every case renders with alphaTab; key facts are visible in the SVG', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}#/score-check`);
  for (const id of CASES) await expect(page.getByTestId(`sheet-${id}`)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  for (const id of CASES) await page.getByTestId(`case-${id}`).screenshot({ path: `${OUT}/${id}.png` });
  expect(errors).toEqual([]);
  // 튜닝 표기, 보표 선택, 주법·경고 문구(렌더된 SVG 텍스트)
  expect((await texts(page, 'five-tab')).join(' ')).toMatch(/5-string bass/);
  expect(await page.getByTestId('sheet-five-tab').locator('svg text', { hasText: /^0$/ }).count()).toBeGreaterThan(0);
  const tech = await texts(page, 'tech');
  expect(tech.filter((t) => t === 'S').length).toBeGreaterThanOrEqual(2); // slap (TAB+오선)
  expect(tech.filter((t) => t === 'P').length).toBeGreaterThanOrEqual(1); // pop
  expect(tech.filter((t) => t === 'H').length).toBeGreaterThanOrEqual(1); // hammer-on
  expect(tech).toContain('x');                                           // dead note
  expect((await texts(page, 'unsupported')).join(' ')).toMatch(/표기 불가 리듬/);
  await expect(page.getByTestId('case-unsupported').locator('li[data-code="UNSUPPORTED_RHYTHM"]')).toHaveClass(/err/);
  await expect(page.getByTestId('case-unsupported').locator('li[data-code="OVERLAPPING_VOICES"]')).toHaveClass(/warn/);
  expect((await texts(page, 'four-both')).join(' ')).toMatch(/\(2\)/); // 마디 넘김 붙임줄의 TAB 괄호 표기
  // 셈여림 기본값(f)이 임의로 찍히지 않음: SMuFL dynamic f = U+E522
  for (const id of CASES) expect((await texts(page, id)).some((t) => t.includes(''))).toBe(false);
});

test('print layout: A4 PDF via the browser print path, multi-page, systems kept whole, only the score printed', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${BASE}#/score-check`);
  for (const id of CASES) await expect(page.getByTestId(`sheet-${id}`)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await page.emulateMedia({ media: 'print' });
  // 인쇄 media 에서 각 줄(system) 조각은 흐름 배치 + break-inside: avoid, 높이는 A4 본문(273mm ≈ 1032px)보다 작다
  const parts = await page.locator('.score-sheet .at-surface > div').evaluateAll((els) => els.map((e) => { const s = getComputedStyle(e); return { pos: s.position, brk: s.breakInside, h: e.getBoundingClientRect().height }; }));
  expect(parts.length).toBeGreaterThan(CASES.length);
  expect(parts.every((p) => p.pos === 'relative' && p.brk === 'avoid' && p.h < 1032)).toBe(true);
  const file = `${OUT}/score-check.pdf`;
  await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true });
  const pages = pdfPages(file);
  const all = pdfText(file);
  console.log(JSON.stringify({ pages, systems: parts.length, maxSystemPx: Math.max(...parts.map((p) => p.h)) }));
  expect(pages).toBeGreaterThanOrEqual(CASES.length + 2); // 사례마다 새 쪽 + 120마디 곡은 3쪽 이상
  expect(all).not.toMatch(/악보 출력 검증|돌아가기|진단 없음/); // 화면 전용 UI 는 인쇄되지 않음
  for (const t of ['Rhythm', 'Five', 'Six', 'DropD', 'Tech', 'Unsupported', 'Long song']) expect(all).toContain(t);
  // 120마디 곡: 여러 쪽에 걸치고 각 쪽에 내용이 있다
  const longPages: number[] = [];
  for (let p = 1; p <= pages; p++) if (/Long song/.test(pdfText(file, p)) || longPages.length) longPages.push(p);
  expect(longPages.length).toBeGreaterThanOrEqual(3);
  for (const p of longPages) expect(pdfText(file, p).replace(/\s/g, '').length).toBeGreaterThan(20);
  execFileSync('pdftoppm', ['-png', '-r', '50', '-f', String(longPages[0]), '-l', String(longPages[1]), file, `${OUT}/long-page`]);
});

test('editor: bass track → bar range + key + staves → preview → print to PDF; the project is unchanged', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Score export');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Bass TAB' }).click();
  await page.waitForTimeout(1500);
  const st = () => page.evaluate(() => (window as unknown as { __bassdaw: { state(): { project: { tracks: { id: string; clips: { id: string }[] }[] } } } }).__bassdaw.state().project);
  const clipId = (await st()).tracks[0].clips[0].id;
  const notes = [[0, 960, 0, 0], [960, 960, 1, 2, [{ kind: 'slap' }]], [1920, 1920, 2, 2], [3840 + 2880, 1920, 0, 3], [3840 * 2 + 960, 960, 3, 5, [{ kind: 'pop' }]]];
  await page.evaluate(({ clipId, notes }) => (window as unknown as { __bassdaw: { state(): { run(l: string, c: unknown): boolean } } }).__bassdaw.state().run('notes', { type: 'EditNotes', clipId, ops: notes.map(([tick, durationTicks, stringIndex, fret, techniques], i) => ({ op: 'add', collection: 'notes', item: { id: `sn${i}`, tick, durationTicks, stringIndex, fret, velocity: 100, techniques: techniques ?? [] } })) }), { clipId, notes });
  await page.getByRole('button', { name: '복구본 저장' }).click(); await waitSaved(page);
  const dbg = () => page.evaluate(async () => { const w = window as unknown as { __bassdaw: { projectHash(): Promise<string>; planHash(): { hash: string }; state(): { editSeq: number } } }; return { hash: await w.__bassdaw.projectHash(), plan: w.__bassdaw.planHash().hash, seq: w.__bassdaw.state().editSeq }; });
  const before = await dbg();
  await page.getByRole('tab', { name: '악보', exact: true }).click();
  await expect(page.getByLabel('악보 트랙')).toHaveValue(/.+/);
  await page.getByLabel('악보 범위').selectOption('bars');
  await page.getByLabel('시작 마디', { exact: true }).fill('2'); await page.getByLabel('끝 마디', { exact: true }).fill('3');
  await page.getByLabel('조표').selectOption('-3:minor');
  await page.getByLabel('보표').selectOption('both');
  await expect(page.locator('li[data-code="RANGE_TIE_IN"], li[data-code="BAR_NUMBERS"]').first()).toBeVisible();
  await page.getByRole('button', { name: '악보 미리보기' }).click();
  await expect(page.getByTestId('print-sheet')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const t = await page.getByTestId('print-sheet').evaluate((el) => [...el.querySelectorAll('svg text')].map((x) => x.textContent).join(' '));
  expect(t).toMatch(/Score export/); expect(t).toMatch(/마디 2–3/); expect(t).toMatch(/P/);
  await page.getByTestId('print-sheet').screenshot({ path: `${OUT}/editor-preview.png` });
  // 인쇄: window.print 는 headless 에서 대화상자가 없으므로 같은 print media 렌더를 page.pdf 로 저장
  let printed = false;
  await page.exposeFunction('__printCalled', () => { printed = true; });
  await page.evaluate(() => { window.print = () => { (window as unknown as { __printCalled(): void }).__printCalled(); }; });
  await page.getByRole('button', { name: '인쇄 / PDF로 저장' }).click();
  expect(printed).toBe(true);
  const file = `${OUT}/editor-print.pdf`;
  await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true });
  const txt = pdfText(file);
  expect(txt).toMatch(/Score export/);
  expect(txt).not.toMatch(/믹서|자동화|프로젝트 목록|인쇄 미리보기|닫기/); // 편집기 UI 는 인쇄되지 않음
  expect(pdfPages(file)).toBe(1);
  await page.getByRole('button', { name: '닫기' }).click();
  // 출력 전후 원본·재생 계획·편집 sequence 동일, 저장 상태 변화 없음
  expect(await dbg()).toEqual(before);
  await expect(page.getByTestId('save-status')).toHaveText('저장됨');
});
