import { test, expect } from '@playwright/test';
import { persistent, BASE, waitSaved } from './helpers.ts';
import { readFileSync } from 'node:fs';

test('L01 + MVP-1 demo: create → 4 tracks → rename/tempo → undo/redo → save → restart → same state', async () => {
  const { ctx, dir } = await persistent();
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('L01 song');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  for (const b of ['+ Bass TAB', '+ Guitar TAB', '+ Keys', '+ Drums']) { await page.getByRole('button', { name: b }).click(); await page.waitForTimeout(200); }
  // Adding a track also loads its kit asynchronously; finish setup before testing Undo.
  await page.waitForFunction(() => {
    const p = (window as any).__bassdaw.state().project;
    return p.tracks.length === 4 && p.tracks.every((t: any) => {
      const state = p.plugins.find((x: any) => x.instanceId === t.instrumentSlot)?.state;
      return t.kind === 'drum' ? state?.pads?.length > 0 : state?.zones?.length > 0;
    });
  });
  await page.getByRole('button', { name: 'Bass 이름 변경' }).click();
  await page.getByLabel('트랙 이름').fill('Fretless');
  await page.getByLabel('트랙 이름').press('Enter');
  await page.getByLabel('템포').fill('97');
  await page.getByLabel('템포').press('Enter');
  await page.getByRole('button', { name: '실행 취소' }).click(); // tempo undo
  await expect(page.getByLabel('템포')).toHaveValue('120');
  await page.getByRole('button', { name: '다시 실행' }).click();
  await expect(page.getByLabel('템포')).toHaveValue('97');
  await waitSaved(page);
  await ctx.close();
  // 브라우저 재시작
  const again = await persistent(dir);
  const p2 = again.ctx.pages()[0] ?? await again.ctx.newPage();
  await p2.goto(BASE);
  await p2.getByRole('button', { name: 'L01 song 열기' }).click();
  await expect(p2.locator('.track-head .name').first()).toContainText('Fretless');
  await expect(p2.locator('.track-head')).toHaveCount(4);
  await expect(p2.getByLabel('템포')).toHaveValue('97');
  // B01: SW 가 제어 중이면 오프라인 cold start
  await p2.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
  await again.ctx.setOffline(true);
  await p2.reload();
  await expect(p2.getByRole('heading', { name: 'Bass TAB DAW' })).toBeVisible();
  await p2.getByRole('button', { name: 'L01 song 열기' }).click();
  await expect(p2.locator('.track-head')).toHaveCount(4);
  await again.ctx.close();
});

test('L05 archive: export .dawbae → import into a fresh browser profile as a new copy', async () => {
  const a = await persistent();
  const page = await a.ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Archive me');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Bass TAB' }).click();
  await page.waitForFunction(() => document.title && true);
  await page.waitForTimeout(3000); // kit 자산 import 완료 대기
  await waitSaved(page);
  await page.getByRole('tab', {name:'내보내기',exact:true}).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '.dawbae 파일 내려받기', exact: true }).click();
  const file = 'tests/artifacts/archive-me.dawbae';
  await (await dl).saveAs(file);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  await a.ctx.close();
  const b = await persistent();
  const p2 = await b.ctx.newPage();
  await p2.goto(BASE);
  await expect(p2.getByText('OPFS + IndexedDB')).toBeVisible();
  await p2.locator('input[type=file][accept*="bassdaw"]').setInputFiles(file);
  await expect(p2.getByLabel('프로젝트 제목', {exact:true})).toHaveValue('Archive me', {timeout:20000});
  await expect(p2.getByLabel('프로젝트 제목', {exact:true})).toHaveValue('Archive me');
  await expect(p2.locator('.track-head')).toHaveCount(1);
  // 악성 ZIP 거절
  await p2.getByRole('button', { name: '프로젝트 목록' }).click();
  await p2.locator('input[type=file][accept*="bassdaw"]').setInputFiles({ name: 'evil.dawbae', mimeType: 'application/zip', buffer: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary') });
  await expect(p2.locator('.toast.error')).toContainText(/Import refused/);
  await b.ctx.close();
});

test('L04 two tabs: second tab read-only, takeover fences the first tab', async () => {
  const { ctx } = await persistent();
  const a = await ctx.newPage();
  await a.goto(BASE);
  await a.getByLabel('새 프로젝트 제목').fill('Two tabs');
  await a.getByRole('button', { name: '새 프로젝트' }).click();
  await waitSaved(a).catch(() => undefined);
  const b = await ctx.newPage();
  await b.goto(BASE);
  await b.getByRole('button', { name: 'Two tabs 열기' }).click();
  await expect(b.getByTestId('save-status')).toHaveText('읽기 전용');
  await b.getByRole('button', { name: '이 탭에서 편집(가져오기)' }).click();
  await expect(b.getByTestId('save-status')).not.toHaveText('읽기 전용');
  // A 탭은 다음 write 에서 거절되고 read-only 로 전환
  await a.getByRole('button', { name: '+ Keys' }).click();
  await expect(a.getByTestId('save-status')).toHaveText('읽기 전용', { timeout: 15_000 });
  await b.getByRole('button', { name: '+ Drums' }).click();
  await waitSaved(b);
  await ctx.close();
});

test('L04b: a frozen (unresponsive) writer tab is not treated as closed; explicit takeover fences it', async () => {
  test.setTimeout(120_000);
  const { ctx } = await persistent();
  const a = await ctx.newPage();
  await a.goto(BASE);
  await a.getByLabel('새 프로젝트 제목').fill('Frozen writer');
  await a.getByRole('button', { name: '새 프로젝트' }).click();
  await waitSaved(a).catch(() => undefined);
  const titleOf = (p: typeof a) => p.evaluate(() => (window as unknown as { __bassdaw: { state(): { project: { tracks: unknown[] } | null } } }).__bassdaw.state().project?.tracks.length ?? -1);
  // A 를 freeze: 타이머·heartbeat 정지 → IDB lease 가 만료(10s)되지만 탭은 살아 있고 Web Lock 도 쥐고 있다
  const cdp = await ctx.newCDPSession(a);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise((r) => setTimeout(r, 12_000));
  const b = await ctx.newPage();
  await b.goto(BASE);
  await b.getByRole('button', { name: 'Frozen writer 열기' }).click();
  await expect(b.getByTestId('save-status')).toHaveText('읽기 전용'); // 응답 지연만으로 takeover 하지 않음
  // A 가 깨어나면 여전히 writer: 편집·저장 성공
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await a.getByRole('button', { name: '+ Keys' }).click();
  await waitSaved(a);
  expect(await titleOf(a)).toBe(1);
  // B 의 명시적 takeover → A 는 즉시 read-only, 이후 A 의 write 는 저장되지 않는다
  await b.getByRole('button', { name: '이 탭에서 편집(가져오기)' }).click();
  await expect(b.getByTestId('save-status')).not.toHaveText('읽기 전용');
  expect(await titleOf(b)).toBe(1); // A 가 마지막으로 저장한 head 를 이어받음
  await expect(a.getByTestId('save-status')).toHaveText('읽기 전용', { timeout: 10_000 });
  // UI 가 막아도 내부 commit 경로를 직접 호출해 stale epoch/head write 가 거절되는지 확인
  const stale = await a.evaluate(async () => {
    const st = (window as unknown as { __bassdaw: { state(): { store: { commit(p: unknown, h: string | null, s: number): Promise<{ ok: boolean; errors?: { code: string }[] }>; getRecord(id: string): Promise<{ head: string }> }; project: { id: string; title: string } } } }).__bassdaw.state();
    const rec = await st.store.getRecord(st.project.id);
    const r1 = await st.store.commit({ ...st.project, title: 'stale A' }, rec.head, 99);
    return r1.ok ? 'committed' : r1.errors![0].code;
  });
  expect(stale).toBe('WRITER_LOST');
  await b.getByRole('button', { name: '+ Drums' }).click();
  await waitSaved(b);
  // 새 탭에서 열면 B 의 결과만 보인다
  const c = await ctx.newPage();
  await c.goto(BASE);
  await c.getByRole('button', { name: 'Frozen writer 열기' }).click();
  await expect(c.getByTestId('save-status')).toHaveText('읽기 전용'); // B 가 살아 있는 writer
  expect(await titleOf(c)).toBe(2);
  expect(await c.evaluate(() => (window as unknown as { __bassdaw: { state(): { project: { title: string } } } }).__bassdaw.state().project.title)).toBe('Frozen writer');
  await ctx.close();
});
