import { test, expect, type Page } from '@playwright/test';
import { persistent, BASE, waitSaved } from './helpers.ts';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { bundleOf } from '../fixtures/plugins.ts';

const run = (page: Page, c: unknown) => page.evaluate((cmd) => (window as unknown as { __bassdaw: { state(): { run(l: string, c: unknown): boolean } } }).__bassdaw.state().run('test', cmd), c);
const proj = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __bassdaw: { state(): { project: unknown } } }).__bassdaw.state().project)));

async function installSample(page: Page, label: string) {
  await page.getByRole('tab', { name: '플러그인' }).click();
  await page.getByRole('button', { name: `샘플 검사: ${label}` }).click();
  await expect(page.getByText('✓ 목록 hash 일치')).toBeVisible();
  await page.getByRole('button', { name: '이 hash 를 승인하고 설치' }).click();
  await expect(page.locator('.toast', { hasText: '설치됨' }).last()).toBeVisible({ timeout: 20_000 });
}

test('MVP-6 demo: install → gain + one-shot active → automation → restart → missing preserved → fault bypass → processorerror recovery', async () => {
  test.setTimeout(300_000);
  const { ctx, dir } = await persistent();
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Plugs');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Keys' }).click();
  await page.waitForTimeout(2500);
  await page.locator('rect[data-testid^="clip-"]').first().click({ position: { x: 20, y: 10 } });
  await page.getByRole('tab', { name: '편집' }).click();
  const pr = page.getByRole('grid', { name: /피아노 롤/ });
  await pr.evaluate((el) => { (el.parentElement as HTMLElement).scrollTop = 600; });
  const b = (await pr.boundingBox())!;
  for (let i = 0; i < 8; i++) await page.mouse.click(b.x + 10 + i * 64, b.y + 700);
  for (const l of ['Sample Gain', 'One-shot Sampler', 'Fault Demo (diagnostic)']) await installSample(page, l);
  await expect(page.getByTestId('installed-com.bassdaw.gain')).toBeVisible();
  // 믹서: Keys 에 gain effect, instrument → one-shot
  await page.getByRole('tab', { name: '믹서' }).click();
  await page.getByLabel('effect 추가').first().selectOption({ label: 'Sample Gain (com.bassdaw.gain@1.0.0)' });
  await page.getByLabel('Keys instrument').selectOption('com.bassdaw.oneshot@1.0.0');
  let p = await proj(page);
  const gainInst = p.plugins.find((x: { pluginId: string }) => x.pluginId === 'com.bassdaw.gain');
  expect(p.metadata['pluginHash:com.bassdaw.gain@1.0.0']).toMatch(/^[0-9a-f]{64}$/);
  // 자동화
  await page.getByRole('tab', { name: '자동화' }).click();
  await page.getByLabel('자동화 대상').selectOption({ label: 'Keys · com.bassdaw.gain · Gain' });
  await page.getByRole('button', { name: 'lane 추가' }).click();
  // 재생
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(page.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 30_000 });
  await page.getByRole('button', { name: '재생', exact: true }).click();
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('plugin-faults')).toHaveText('0');
  await expect(page.getByTestId('underruns')).toHaveText(/^0 \//);
  await page.getByRole('button', { name: '정지', exact: true }).click();
  await waitSaved(page);
  await ctx.close();

  const again = await persistent(dir);
  const p2 = again.ctx.pages()[0] ?? await again.ctx.newPage();
  await p2.goto(BASE);
  await p2.getByRole('button', { name: 'Plugs 열기' }).click();
  await p2.getByRole('tab', { name: '믹서' }).click();
  await expect(p2.getByTestId('effect-com.bassdaw.gain').getByText('missing')).toHaveCount(0);
  // 제거 → missing 으로 보존, export 차단
  await p2.getByRole('tab', { name: '플러그인' }).click();
  p2.once('dialog', (d) => d.accept());
  await p2.getByTestId('installed-com.bassdaw.gain').getByRole('button', { name: '제거' }).click();
  await p2.getByRole('tab', { name: '믹서' }).click();
  await expect(p2.getByTestId('effect-com.bassdaw.gain').getByText('missing')).toBeVisible();
  p = await proj(p2);
  expect(p.plugins.find((x: { instanceId: string }) => x.instanceId === gainInst.instanceId)).toEqual(gainInst);
  await p2.getByRole('tab', { name: '내보내기' }).click();
  await p2.getByRole('button', { name: 'WAV 렌더' }).click();
  await expect(p2.getByText(/EXPORT_BLOCKED/)).toBeVisible({ timeout: 60_000 });
  // fault 주입: fault demo effect mode=2(trap)
  await p2.getByRole('tab', { name: '믹서' }).click();
  await p2.getByLabel('effect 추가').first().selectOption({ label: 'Fault Demo (diagnostic) (com.bassdaw.faultdemo@1.0.0)' });
  p = await proj(p2);
  const fd = p.plugins.find((x: { pluginId: string }) => x.pluginId === 'com.bassdaw.faultdemo');
  await run(p2, { type: 'SetParameter', owner: 'plugin', ownerId: fd.instanceId, parameterId: 'mode', value: 2 });
  await p2.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await p2.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(p2.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 30_000 });
  await p2.getByRole('button', { name: '재생', exact: true }).click();
  await expect(p2.getByTestId('plugin-faults')).toContainText('trap', { timeout: 10_000 });
  await expect(p2.getByTestId('engine-state')).toHaveText('playing'); // 다른 경로는 계속 재생
  p = await proj(p2);
  expect(p.plugins.find((x: { instanceId: string }) => x.instanceId === fd.instanceId).parameters.mode).toBe(2); // state 보존
  // processorerror → node 재생성 → paused
  await p2.getByRole('button', { name: 'processorerror 주입' }).click();
  await expect(p2.getByTestId('engine-state')).toHaveText('paused', { timeout: 20_000 });
  await again.ctx.close();
});

test('P04: malicious sandbox UI cannot reach network, parent, other instances or assets', async ({ page }) => {
  test.setTimeout(180_000);
  // 악성 UI 번들은 e2e 빌드에서만 검토 목록에 추가된다(scripts/build-e2e.mjs). 리뷰를 통과한 플러그인의 UI 가 악성인 경우를 가정한다.
  const exfil: string[] = [];
  const srv = createServer((req, res) => { exfil.push(req.url!); res.writeHead(204, { 'Cross-Origin-Resource-Policy': 'cross-origin' }); res.end(); }).listen(4199);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Evil');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Keys' }).click();
  await page.getByRole('button', { name: '+ Drums' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('tab', { name: '플러그인' }).click();
  await page.locator('input[accept=".bdplugin,.zip"]').setInputFiles('tests/artifacts/e2e-plugins/evilui.bdplugin');
  await expect(page.getByTestId('review-state')).toContainText('검토된 고정 hash');
  await page.getByRole('button', { name: '이 hash 를 승인하고 설치' }).click();
  await expect(page.locator('.toast', { hasText: '설치됨' })).toBeVisible({ timeout: 20_000 });
  await installSample(page, 'Sample Gain');
  await page.getByRole('tab', { name: '믹서' }).click();
  await page.getByLabel('effect 추가').first().selectOption({ label: 'Evil UI (com.example.evilui@1.0.0)' });
  await page.getByLabel('effect 추가').nth(1).selectOption({ label: 'Sample Gain (com.bassdaw.gain@1.0.0)' });
  const before = await proj(page);
  const evilInst = before.plugins.find((x: { pluginId: string }) => x.pluginId === 'com.example.evilui');
  const other = before.plugins.find((x: { pluginId: string }) => x.pluginId === 'com.bassdaw.gain');
  await page.getByTestId('effect-com.example.evilui').getByRole('button', { name: 'UI', exact: true }).click();
  const frame = page.getByTestId(`plugin-ui-${evilInst.instanceId}`);
  await expect(frame).toHaveAttribute('data-connected', 'true', { timeout: 10_000 });
  await page.waitForTimeout(3000);
  const rejected = Number(await frame.getAttribute('data-rejected'));
  console.log('rejected messages', rejected, 'exfil', exfil);
  expect(rejected).toBeGreaterThanOrEqual(6 + 20); // nonce 위조·미지 파라미터·범위·asset·oversize·미지 타입 + 60/s 초과분
  expect(exfil).toEqual([]);
  const after = await proj(page);
  expect(after.plugins.find((x: { instanceId: string }) => x.instanceId === other.instanceId).parameters).toEqual(other.parameters); // 다른 instance 불변
  expect(after.plugins.find((x: { instanceId: string }) => x.instanceId === evilInst.instanceId).parameters.gain).toBe(2); // 자기 파라미터의 정상 변경만 반영
  expect(await page.evaluate(() => document.title)).toBe('Bass TAB DAW'); // 부모 탐색/변경 없음
  expect(page.url()).toContain('localhost:4173');
  srv.close();
});

test('D05: a local bundle whose hash is not on the reviewed list cannot be installed (UI and API)', async ({ page }) => {
  const bytes = await bundleOf('gain', { manifest: (m) => ({ ...m, pluginId: 'com.example.unreviewed', name: 'Unreviewed' }) });
  writeFileSync('tests/artifacts/unreviewed.bdplugin', bytes);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Policy');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('tab', { name: '플러그인' }).click();
  await page.locator('input[accept=".bdplugin,.zip"]').setInputFiles('tests/artifacts/unreviewed.bdplugin');
  await expect(page.getByTestId('review-state')).toContainText('검토 목록에 없는 hash');
  await expect(page.getByRole('button', { name: '이 hash 를 승인하고 설치' })).toBeDisabled();
  // UI 를 우회해 host.install 을 직접 호출해도 거절
  const code = await page.evaluate(async (b) => {
    const host = (window as unknown as { __bassdaw: { state(): { pluginHost: { inspect(x: Uint8Array): Promise<{ ok: boolean; value: { bundleHash: string } }>; install(m: unknown, h: string, x: Uint8Array): Promise<{ ok: boolean; errors?: { code: string }[] }> } } } }).__bassdaw.state().pluginHost;
    const u = new Uint8Array(b); const i = await host.inspect(u);
    const r = await host.install(i.value, i.value.bundleHash, u);
    return r.ok ? 'installed' : r.errors![0].code;
  }, [...bytes]);
  expect(code).toBe('PLUGIN_NOT_REVIEWED');
  await expect(page.getByTestId('installed-com.example.unreviewed')).toHaveCount(0);
});

test('item 2: inserting a WASM plugin during playback compiles only after the pause ack (transport idle); a compile request while playing is refused', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Compile phase');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Keys' }).click();
  await page.waitForTimeout(2000);
  await installSample(page, 'Sample Gain');
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(page.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 30_000 });
  await page.getByRole('button', { name: '재생', exact: true }).click();
  await expect(page.getByTestId('engine-state')).toHaveText('playing');
  // 재생 중 effect 삽입 → 엔진은 pause ack → prepareWasm → load → 재개
  await page.getByRole('tab', { name: '믹서' }).click();
  await page.getByLabel('effect 추가').first().selectOption({ label: 'Sample Gain (com.bassdaw.gain@1.0.0)' });
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(page.getByTestId('wasm-compiles')).toContainText('com.bassdaw.gain@1.0.0:idle', { timeout: 15_000 });
  await expect(page.getByTestId('engine-state')).toHaveText('playing', { timeout: 10_000 });
  // 재생 중 직접 컴파일 요청(다른 key) → worklet 이 거절
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __bassdaw: { state(): { pluginHost: { installedBundle(k: string): Promise<{ dsp: Uint8Array } | null> } }; engine: { prepareWasm(e: [string, Uint8Array][], keep: string[]): Promise<{ refused: string[]; compiled: string[]; transport: string } | null>; status: { state: string } } } };
    const b = await w.__bassdaw.state().pluginHost.installedBundle('com.bassdaw.gain@1.0.0');
    const state = w.__bassdaw.engine.status.state;
    const x = await w.__bassdaw.engine.prepareWasm([['probe@0', b!.dsp]], ['com.bassdaw.gain@1.0.0', 'probe@0']);
    return { state, x };
  });
  expect(r.state).toBe('playing');
  expect(r.x!.transport).not.toBe('idle');
  expect(r.x!.refused).toEqual(['probe@0']);
  expect(r.x!.compiled).toEqual([]);
  const log = JSON.parse((await page.getByTestId('wasm-compiles').getAttribute('data-json'))!) as { key: string; transport: string; ok: boolean }[];
  expect(log.filter((l) => l.ok).every((l) => l.transport === 'idle')).toBe(true);
  expect(log.some((l) => l.ok && l.key === 'com.bassdaw.gain@1.0.0')).toBe(true);
  await expect(page.getByTestId('plugin-faults')).toHaveText('0');
  await page.getByRole('button', { name: '정지', exact: true }).click();
});
