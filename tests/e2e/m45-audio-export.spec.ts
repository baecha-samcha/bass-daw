import { test, expect, type Page } from '@playwright/test';
import { persistent, BASE, waitSaved } from './helpers.ts';
import { readFileSync } from 'node:fs';
import { parseWav } from '../fixtures/wavparse.ts';
import { parseSmf } from '../fixtures/midiparse.ts';

function wavBytes(seconds: number, sr = 44100, channels = 2): Buffer {
  const n = Math.round(seconds * sr); const b = Buffer.alloc(44 + n * channels * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * channels * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * channels * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), 44 + (i * channels + c) * 2);
  return b;
}
const dbg = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __bassdaw: { state(): { project: { tempoMap: { bpm: number }[]; tracks: { kind: string; clips: { kind: string; startSeconds?: number; sourceFrameCount?: number; sourceStartFrame?: number }[] }[]; assets: { sha256: string; byteLength: number }[] } } } }).__bassdaw.state(); return JSON.parse(JSON.stringify(s.project)); });

test('R03 + MVP-4 demo: import audio → split/trim/fade → undo → tempo change keeps seconds; original SHA unchanged', async ({ page }) => {
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Audio');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Audio' }).click();
  await page.getByRole('tab', { name: '녹음/가져오기' }).click();
  const src = wavBytes(3);
  await page.locator('input[type=file][accept^="audio"]').setInputFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: src });
  await expect(page.locator('rect[data-testid^="clip-"]')).toHaveCount(1, { timeout: 20_000 });
  let p = await dbg(page);
  const sha = p.assets[0].sha256;
  expect(sha).toBe((await import('node:crypto')).createHash('sha256').update(src).digest('hex'));
  expect(p.assets[0].byteLength).toBe(src.length);
  // 선택 + split (1.0s = 2박@120 = 1920 tick)
  const clip = (await page.locator('rect[data-testid^="clip-"]').boundingBox())!;
  await page.mouse.click(clip.x + 10, clip.y + 10);
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  await page.mouse.click(ruler.x + 48 * 2 + 1, ruler.y + 5);
  await page.getByRole('button', { name: '재생위치 분할' }).click();
  p = await dbg(page);
  const clips = p.tracks[0].clips;
  expect(clips.length).toBe(2);
  expect(clips[0].sourceFrameCount! + clips[1].sourceFrameCount!).toBe(3 * 44100);
  // 편집기에서 fade/gain/trim
  await page.locator('rect[data-testid^="clip-"]').nth(1).click({ position: { x: 20, y: 10 } });
  await page.getByRole('tab', { name: '편집' }).click();
  await page.getByLabel('fade in ms').fill('50'); await page.getByLabel('fade in ms').blur();
  await page.getByLabel('길이 초').fill('1.5'); await page.getByLabel('길이 초').blur();
  p = await dbg(page);
  expect(p.tracks[0].clips[1].sourceFrameCount).toBe(Math.round(1.5 * 44100));
  await page.getByRole('button', { name: '실행 취소' }).click();
  p = await dbg(page);
  expect(p.tracks[0].clips[1].sourceFrameCount).toBe(2 * 44100);
  const before = p.tracks[0].clips.map((c: { startSeconds: number; sourceFrameCount: number }) => [c.startSeconds, c.sourceFrameCount]);
  await page.getByLabel('템포').fill('90'); await page.getByLabel('템포').press('Enter');
  p = await dbg(page);
  expect(p.tempoMap[0].bpm).toBe(90);
  expect(p.tracks[0].clips.map((c: { startSeconds: number; sourceFrameCount: number }) => [c.startSeconds, c.sourceFrameCount])).toEqual(before);
  expect(p.assets[0].sha256).toBe(sha);
});

test('R01/R02/R05 + recording: fake mic → record 11s (2 closed segments) → crash → recover closed segments', async () => {
  const { ctx, dir } = await persistent();
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Rec');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Audio' }).click();
  await page.getByRole('button', { name: '🔊 오디오 시작' }).click();
  await page.getByRole('tab', { name: '녹음/가져오기' }).click();
  await page.getByRole('button', { name: '입력 권한 요청/준비' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('armed', { timeout: 15_000 });
  await expect(page.getByText(/실제 settings/)).toContainText('"echoCancellation":false');
  // 1) 정상 녹음 3초
  await page.getByRole('button', { name: '● 녹음' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('recording', { timeout: 10_000 });
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: '■ 녹음 정지' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText(/armed|committed/, { timeout: 20_000 });
  const p1 = await dbg(page);
  const take = p1.tracks[0].clips[0];
  expect(take.kind).toBe('audio');
  expect(take.sourceFrameCount).toBeGreaterThan(48000 * 2.5);
  // 2) 녹음 도중 크래시: 11초(닫힌 segment 2개) 후 브라우저 강제 종료
  await page.getByRole('button', { name: '● 녹음' }).click();
  await expect(page.getByTestId('rec-state')).toHaveText('recording', { timeout: 10_000 });
  await page.waitForTimeout(11_500);
  await waitSaved(page).catch(() => undefined);
  await ctx.close();
  const again = await persistent(dir);
  const p2 = again.ctx.pages()[0] ?? await again.ctx.newPage();
  await p2.goto(BASE);
  // 크래시한 탭의 lease(TTL 10s)가 남아 있으므로 명시적 takeover 로 연다
  await p2.getByRole('button', { name: '가져와 편집' }).click();
  await p2.getByRole('tab', { name: '녹음/가져오기' }).click();
  await expect(p2.getByText('미완료 녹음')).toBeVisible({ timeout: 10_000 });
  await expect(p2.getByText(/닫힌 segment 2개/)).toBeVisible();
  await p2.getByRole('button', { name: '새 오디오 클립으로 복구' }).click();
  await expect(p2.getByText('미완료 녹음')).toHaveCount(0, { timeout: 20_000 });
  const p3 = await dbg(p2);
  const clips = p3.tracks[0].clips;
  expect(clips.length).toBe(2);
  // 닫힌 segment 2개(각 ≥5초, 2048-frame chunk 단위)만 복구 — 마지막 미완료 segment 는 제외
  expect(clips[1].sourceFrameCount).toBeGreaterThanOrEqual(48000 * 10);
  expect(clips[1].sourceFrameCount).toBeLessThan(48000 * 10 + 2 * 2048 + 1);
  await again.ctx.close();
});

test('X01/X02/X03 + MVP-5 demo: bus/send/EQ/comp/reverb + automation → WAV & MIDI export; missing asset blocks export', async ({ page }) => {
  await page.goto(BASE);
  await page.getByLabel('새 프로젝트 제목').fill('Mix');
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '+ Bass TAB' }).click();
  await page.getByRole('button', { name: '+ Drums' }).click();
  await page.waitForTimeout(3000);
  // 드럼 hit 몇 개
  const clips = page.locator('rect[data-testid^="clip-"]');
  await clips.nth(1).click({ position: { x: 30, y: 10 } });
  await page.getByRole('tab', { name: '편집' }).click();
  for (let i = 0; i < 32; i += 4) await page.getByRole('gridcell', { name: `Kick ${i + 1}`, exact: true }).click();
  // 믹서: 버스 + send + effects
  await page.getByRole('tab', { name: '믹서' }).click();
  await page.getByRole('button', { name: '+ 버스' }).click();
  await page.getByLabel('send 추가').first().selectOption({ label: 'Bus 1' });
  await page.getByLabel('effect 추가').first().selectOption('builtin.eq');
  await page.getByLabel('effect 추가').first().selectOption('builtin.compressor');
  await page.getByLabel('effect 추가').nth(2).selectOption('builtin.reverb');
  // 자동화: master gain lane
  await page.getByRole('tab', { name: '자동화' }).click();
  await page.getByLabel('자동화 대상').selectOption({ label: 'Master · Gain' });
  await page.getByRole('button', { name: 'lane 추가' }).click();
  const lane = (await page.getByLabel('자동화 lane').boundingBox())!;
  await page.mouse.click(lane.x + 48 * 4, lane.y + 60);
  await waitSaved(page);
  // WAV
  await page.getByRole('tab', { name: '내보내기' }).click();
  await page.getByLabel(/Tail/).fill('1');
  const dl = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'WAV 렌더' }).click();
  const wav = await dl; await wav.saveAs('tests/artifacts/mix.wav');
  const w = parseWav(new Uint8Array(readFileSync('tests/artifacts/mix.wav')));
  expect([w.fmt, w.ch, w.rate, w.bits]).toEqual([1, 2, 48000, 24]);
  expect(w.frames).toBe(48000 * 16 + 48000); // 8마디@120 = 16s + tail 1s
  // MIDI
  const dm = page.waitForEvent('download');
  await page.getByRole('button', { name: '.mid 내보내기' }).click();
  const mid = await dm; await mid.saveAs('tests/artifacts/mix.mid');
  const smf = parseSmf(new Uint8Array(readFileSync('tests/artifacts/mix.mid')));
  expect(smf.format).toBe(1); expect(smf.division).toBe(960);
  await expect(page.getByText('손실 목록')).toBeVisible();
  await expect(page.getByText(/mixer, effects, sends and automation are not exported/)).toBeVisible();
  // X03: 자산 바이트 삭제 → export 차단
  await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('assets'); for await (const [name] of (d as unknown as { entries(): AsyncIterable<[string]> }).entries()) await d.removeEntry(name); });
  await page.evaluate(() => location.reload());
  await page.getByRole('button', { name: 'Mix 열기' }).click();
  await page.getByRole('tab', { name: '내보내기' }).click();
  await page.getByRole('button', { name: 'WAV 렌더' }).click();
  await expect(page.getByText(/EXPORT_BLOCKED/)).toBeVisible({ timeout: 60_000 });
});
