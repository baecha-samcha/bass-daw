import { test, expect, type Page } from '@playwright/test';
import { persistent, BASE, waitSaved } from './helpers.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const rec = (page: Page, fn: string) => page.evaluate((f) => { const r = (window as unknown as { __bassdawRecorder: Record<string, unknown> }).__bassdawRecorder; return (new Function('r', f))(r); }, fn);

test('MVP-2 demo (headless Pi, not a device gate): F02-M2 1min → play → seek/loop → mute/solo/gain → stop', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('tmp');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await page.locator('input[type=number]').last().fill('1');
  await page.getByRole('button', { name: 'F02-M2 열기 (sampler 16트랙)' }).click();
  await expect(page.locator('.track-head')).toHaveCount(16, { timeout: 120_000 });
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  await expect(page.getByTestId('engine-state')).toHaveText(/ready|paused/, { timeout: 60_000 });
  await page.getByRole('button', { name: '재생' }).click();
  await page.waitForTimeout(5000);
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  await page.mouse.click(ruler.x + 48 * 4 * 4, ruler.y + 5); // seek bar 5 (playing 유지)
  await page.getByRole('button', { name: '⟲ 루프' }).click();
  await page.getByRole('button', { name: 'Bass 1 뮤트' }).click();
  await page.getByRole('button', { name: 'Keys 1 솔로' }).click();
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: 'Keys 1 솔로' }).click();
  await page.getByRole('tab', { name: '엔진 진단' }).click();
  const late = await page.getByTestId('late').innerText();
  const under = await page.getByTestId('underruns').innerText();
  console.log('F02-M2 headless:', { late, under, state: await page.getByTestId('engine-state').innerText() });
  await expect(page.getByTestId('engine-state')).toHaveText('playing');
  await page.getByRole('button', { name: '정지', exact: true }).click();
  await expect(page.getByTestId('engine-state')).toHaveText('ready');
});

test('R05: capture lost and quota during recording stop safely and keep closed segments', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('R05');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Audio' }).click();
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '녹음/가져오기' }).click();
  await page.getByRole('button', { name: '입력 권한 요청/준비' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('armed', { timeout: 15_000 });
  // (a) 장치 제거: track ended
  await page.getByRole('button', { name: '● 녹음' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('recording', { timeout: 10_000 });
  await page.waitForTimeout(6000);
  await rec(page, "r.stream.getAudioTracks()[0].dispatchEvent(new Event('ended'));");
  await expect(page.getByText(/CAPTURE_LOST/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(1, { timeout: 20_000 });
  // (b) quota: segment 쓰기 실패 주입 (장치가 제거되었으므로 다시 준비)
  await page.getByRole('button', { name: /입력 권한 요청\/준비|다시 준비/ }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('armed', { timeout: 15_000 });
  await page.getByRole('button', { name: '● 녹음' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('recording', { timeout: 10_000 });
  await page.waitForTimeout(5500);
  await rec(page, "const s = r.store.bytes; const w = s.write.bind(s); s.write = (p, d) => p.startsWith('staging/rec-') ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : w(p, d);");
  await expect(page.getByTestId('rec-state')).toHaveText('recoverable', { timeout: 20_000 });
  await expect(page.getByText(/QUOTA: 녹음을 중단/)).toBeVisible();
  await expect(page.getByText('미완료 녹음')).toBeVisible();
  await expect(page.getByText(/닫힌 segment 1개 \(/)).toBeVisible();
});

test('MVP-5 demo: song + mix → backup → restore in another profile → identical WAV bytes', async () => {
  test.setTimeout(300_000);
  const a = await persistent();
  const page = await a.ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Beta');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Drums' }).click();
  await page.getByRole('button', { name: '+ Audio' }).click();
  await page.waitForTimeout(2500);
  await page.locator('rect[data-testid^="clip-"]').first().click({ position: { x: 30, y: 10 } });
  await page.getByRole('tab', { name: '편집' }).click();
  for (let i = 0; i < 32; i += 2) await page.getByRole('gridcell', { name: `Kick ${i + 1}`, exact: true }).click();
  await page.getByRole('tab', { name: '녹음/가져오기' }).click();
  const n = 48000; const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  await page.locator('input[type=file][accept^="audio"]').setInputFiles({ name: 'vox.wav', mimeType: 'audio/wav', buffer: b });
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole('tab', { name: '믹서' }).click();
  await page.getByRole('button', { name: '+ 버스' }).click();
  await page.getByLabel('send 추가').first().selectOption({ label: 'Bus 1' });
  await page.getByLabel('effect 추가').nth(2).selectOption('builtin.reverb');
  await page.getByLabel('effect 추가').first().selectOption('builtin.compressor');
  await waitSaved(page);
  const exportWav = async (p: Page, name: string) => {
    await p.getByRole('tab', { name: '내보내기' }).click();
    const d = p.waitForEvent('download', { timeout: 120_000 });
    await p.getByRole('button', { name: 'WAV 렌더' }).click();
    const f = `tests/artifacts/${name}.wav`; await (await d).saveAs(f);
    return createHash('sha256').update(readFileSync(f)).digest('hex');
  };
  const h1 = await exportWav(page, 'beta-original');
  await page.getByRole('tab', {name:'내보내기',exact:true}).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '.dawbae 파일 내려받기', exact: true }).click();
  await (await dl).saveAs('tests/artifacts/beta.dawbae');
  await a.ctx.close();
  const bctx = await persistent();
  const p2 = await bctx.ctx.newPage();
  await p2.goto(BASE);
  await expect(p2.getByText('OPFS + IndexedDB')).toBeVisible();
  await p2.locator('input[type=file][accept*="bassdaw"]').setInputFiles('tests/artifacts/beta.dawbae');
  await expect(p2.getByLabel('프로젝트 제목', {exact:true})).toHaveValue('Beta');
  const h2 = await exportWav(p2, 'beta-restored');
  expect(h2).toBe(h1);
  await bctx.ctx.close();
});
