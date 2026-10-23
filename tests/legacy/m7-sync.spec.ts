// RETIRED 2026-10-23: cloud UI replaced by local .dawbae files. Historical scenarios only.
// MVP-7 데모(로컬 fake auth + 로컬 Workers/D1/R2 대체 서버). 두 persistent profile = 두 기기.
import { test, expect, type Page } from '@playwright/test';
import { persistent, BASE, waitSaved } from '../e2e/helpers.ts';

const hash = (p: Page) => p.evaluate(() => (window as unknown as { __bassdaw: { projectHash(): string } }).__bassdaw.projectHash());
const proj = (p: Page) => p.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __bassdaw: { state(): { project: unknown } } }).__bassdaw.state().project)) as { id: string; title: string; tracks: { name: string }[]; tempoMap: { bpm: number }[] });
async function login(p: Page, user: string) {
  await p.getByLabel('개발용 사용자').fill(user);
  await p.getByRole('button', { name: '개발용 로그인(fake)' }).click();
  await expect(p.getByTestId('cloud-owner')).toHaveText(`fake:${user}`);
}
async function setTitle(p: Page, t: string) { const i = p.getByLabel('프로젝트 제목', { exact: true }); await i.fill(t); await i.blur(); }
const syncState = (p: Page) => p.getByTestId('sync-status');

test('MVP-7 demo: local edit → login & link → restore on device B → both edit offline → sync conflict → both kept → open remote copy', async () => {
  test.setTimeout(300_000);
  const user = `u${Date.now().toString(36)}`;
  const A = await persistent(), B = await persistent();
  const a = await A.ctx.newPage(), b = await B.ctx.newPage();
  // 1. 비로그인 로컬 프로젝트 편집
  await a.goto(BASE);
  await a.getByLabel('새 프로젝트 제목').fill('Cloud song');
  await a.getByRole('button', { name: '새 프로젝트' }).click();
  await a.getByRole('button', { name: '+ Bass' }).click();
  await a.waitForTimeout(1500); await waitSaved(a);
  await expect(syncState(a)).toHaveText('로컬 전용');
  // 2. 로그인 후 사용자가 선택해 연결
  await a.getByRole('button', { name: '프로젝트 목록' }).click();
  await login(a, user);
  await expect(a.getByTestId(/^sync-/).first()).toHaveText('로컬 전용'); // 로그인만으로는 업로드하지 않음
  await a.getByRole('button', { name: 'Cloud song 클라우드 연결' }).click();
  await expect(a.getByTestId(/^sync-/).first()).toHaveText('동기화됨', { timeout: 30_000 });
  await a.getByRole('button', { name: 'Cloud song 열기' }).click();
  await a.getByLabel('프로젝트 제목', { exact: true }).waitFor();
  const id = (await proj(a)).id;
  // 키트 로드 등 뒤이은 편집까지 저장·동기화된 뒤의 상태를 기준으로 삼는다
  await a.waitForTimeout(1500); await waitSaved(a);
  await expect(syncState(a)).toHaveText('동기화됨', { timeout: 30_000 });
  const h0 = await hash(a);
  // 3. 다른 기기 복원
  await b.goto(BASE);
  await login(b, user);
  await b.getByRole('button', { name: `클라우드 ${id} 이 기기로 복원` }).click();
  await b.getByRole('button', { name: 'Cloud song 열기' }).click();
  await b.getByLabel('프로젝트 제목', { exact: true }).waitFor();
  expect(await hash(b)).toBe(h0);
  await expect(syncState(b)).toHaveText('동기화됨');
  await b.evaluate(() => navigator.serviceWorker.ready);
  // 4. 두 기기 오프라인 수정 (B 는 Pi/네트워크 off 를 흉내: 오프라인에서 새로고침 → SW 캐시로 실행 → 편집·WAV 내보내기)
  await A.ctx.setOffline(true); await B.ctx.setOffline(true);
  await setTitle(a, 'Cloud song (A)');
  await a.getByRole('button', { name: '복구본 저장' }).click(); await waitSaved(a);
  await b.reload();
  await b.getByRole('button', { name: 'Cloud song 열기' }).click();
  await b.getByRole('button', { name: '+ Drums' }).click();
  await setTitle(b, 'Cloud song (B)');
  await b.getByRole('button', { name: '복구본 저장' }).click(); await waitSaved(b);
  await expect(syncState(b)).not.toHaveText('동기화됨');
  await b.getByRole('tab', { name: '내보내기' }).click();
  const dl = b.waitForEvent('download', { timeout: 120_000 });
  await b.getByRole('button', { name: 'WAV 렌더' }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.wav$/); // C07: 네트워크 없이 export
  // 5. 온라인 복귀 → A 먼저 성공, B 는 충돌
  await A.ctx.setOffline(false);
  await a.getByRole('tab', { name: '동기화' }).click();
  await a.getByRole('button', { name: '지금 동기화' }).click();
  await expect(syncState(a)).toHaveText('동기화됨', { timeout: 30_000 });
  await B.ctx.setOffline(false);
  await b.getByRole('tab', { name: '동기화' }).click();
  await b.getByRole('button', { name: '지금 동기화' }).click();
  await expect(syncState(b)).toHaveText('충돌', { timeout: 30_000 });
  // 6. 두 분기 모두 보존: 비교표
  const panel = b.getByTestId('conflict');
  await expect(panel.getByTestId('cmp-local-title')).toHaveText('Cloud song (B)');
  await expect(panel.getByTestId('cmp-remote-title')).toHaveText('Cloud song (A)', { timeout: 20_000 });
  const bLocal = await proj(b);
  expect(bLocal.tracks.length).toBe(2); // 로컬 작업 그대로
  // 7. 원격 사본 선택 → B 프로젝트 = A 버전, B 작업은 보존된 분기
  await panel.getByRole('button', { name: '원격 사본 열기' }).click();
  await expect(syncState(b)).toHaveText('동기화됨', { timeout: 30_000 });
  await expect.poll(async () => (await proj(b))?.title ?? '', { timeout: 20_000 }).toBe('Cloud song (A)'); // 재열기 중에는 잠시 null
  await b.getByLabel('프로젝트 제목', { exact: true }).waitFor();
  expect((await proj(b)).tracks.length).toBe(1);
  await b.getByRole('tab', { name: '동기화' }).click();
  const br = b.getByTestId('branches');
  await expect(br).toBeVisible();
  await br.getByRole('button', { name: '새 프로젝트로 열기' }).first().click();
  await b.getByRole('button', { name: '프로젝트 목록' }).click();
  await b.getByRole('button', { name: /\(분기 [0-9a-f-]+\) 열기/ }).click();
  await expect.poll(async () => (await proj(b))?.title ?? '').toMatch(/분기/);
  const branch = await proj(b);
  expect(branch.title).toMatch(/분기/);
  expect(branch.tracks.length).toBe(2); // B 의 오프라인 작업(+Drums) 보존
  await A.ctx.close(); await B.ctx.close();
});

test('C03 (UI): logout keeps local projects; sync chip shows login-required, nothing deleted', async () => {
  const user = `v${Date.now().toString(36)}`;
  const A = await persistent();
  const a = await A.ctx.newPage();
  await a.goto(BASE);
  await login(a, user);
  await a.getByLabel('새 프로젝트 제목').fill('Logout keeps me');
  await a.getByRole('button', { name: '새 프로젝트' }).click();
  await waitSaved(a);
  await a.getByRole('button', { name: '프로젝트 목록' }).click();
  await a.getByRole('button', { name: 'Logout keeps me 클라우드 연결' }).click();
  await expect(a.getByTestId(/^sync-/).first()).toHaveText('동기화됨', { timeout: 30_000 });
  await a.getByRole('button', { name: '로그아웃' }).click();
  await expect(a.getByTestId(/^sync-/).first()).toHaveText('로그인 필요');
  await a.reload();
  await expect(a.getByRole('button', { name: 'Logout keeps me 열기' })).toBeVisible();
  await A.ctx.close();
});
