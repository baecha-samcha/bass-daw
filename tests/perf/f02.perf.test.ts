// PERF=1 일 때만 실행. Pi/Node 수치는 참고용이며 실제 Chromebook 실시간 시험(A06/A10)을 대체하지 않는다.
import { it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Asset } from '@bass-daw/schemas';
import { sha256HexSync, uuid } from '@bass-daw/schemas';
import { synthKit, KIT_LICENSE, decodeWav, renderToWav, compilePlan, RenderCore, type KitName, type Pcm } from '@bass-daw/audio-engine';
import { buildF02, f02AudioWav } from '../../apps/web/src/fixtures/f02.ts';

const RUN = process.env.PERF === '1';
const MIN = Number(process.env.F02_MINUTES ?? 2);
const VARIANT = (process.env.F02_VARIANT ?? 'M2') as 'M2' | 'full';
const M5 = process.env.F02_M5 === '1';

it.runIf(RUN)(`F02-${VARIANT}${M5 ? '+M5' : ''} ${MIN}min offline render (Node, Pi)`, async () => {
  const pcm = new Map<string, Pcm>();
  const kits = {} as Record<KitName, Asset[]>;
  for (const k of ['bass', 'guitar', 'keys', 'drums'] as KitName[]) kits[k] = synthKit(k).map((s) => { const h = sha256HexSync(s.bytes); pcm.set(h, decodeWav(s.bytes)); return { id: uuid(), sha256: h, byteLength: s.bytes.length, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: (s.bytes.length - 44) / 2 }, license: { ...KIT_LICENSE } }; });
  const audio: Asset[] = [];
  if (VARIANT === 'full') for (let i = 0; i < 4; i++) { const b = f02AudioWav(20261022 + i); const h = sha256HexSync(b); pcm.set(h, decodeWav(b)); audio.push({ id: uuid(), sha256: h, byteLength: b.length, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: 48000 * 60 }, license: { name: 'f02', origin: 'f02', redistribution: 'allowed' } }); }
  const t0 = performance.now();
  let p = buildF02(kits, audio, { variant: VARIANT, minutes: MIN, m5Load: M5 });
  const ablate = (process.env.F02_ABLATE ?? '').split(',').filter(Boolean);
  if (ablate.length) {
    const drop = new Set(p.plugins.filter((x) => (ablate.includes('eq') && x.pluginId === 'builtin.eq') || (ablate.includes('comp') && x.pluginId === 'builtin.compressor') || (ablate.includes('reverb') && x.pluginId === 'builtin.reverb')).map((x) => x.instanceId));
    p = { ...p, plugins: p.plugins.filter((x) => !drop.has(x.instanceId)), channels: p.channels.map((c) => ({ ...c, effects: c.effects.filter((e) => !drop.has(e)), sends: ablate.includes('sends') ? [] : c.sends })), automation: ablate.includes('automation') ? [] : p.automation.filter((l) => !drop.has(l.target.ownerId)) };
  }
  const buildMs = performance.now() - t0;
  const notes = p.sources.reduce((s, x) => s + ('notes' in x ? x.notes.length : 'hits' in x ? x.hits.length : 0), 0);
  const clips = p.tracks.reduce((s, t) => s + t.clips.length, 0);
  const t1 = performance.now();
  const plan = compilePlan(p, { sampleRate: 48000, assetInfo: (h) => { const x = pcm.get(h); return x ? { sampleRate: 48000, channels: x.channels.length } : null; } });
  if (!plan.ok) throw new Error(plan.message);
  const compileMs = performance.now() - t1;
  // 블록 처리 시간 분포(128 frame) — 실시간 경로와 같은 RenderCore
  const core = new RenderCore(plan.graph, pcm, { maxBlock: 128, polyphony: 64 });
  core.setEvents(plan.events); core.locate(0, true);
  const o = [new Float32Array(128), new Float32Array(128)];
  const times: number[] = [];
  const blocks = Math.min(Math.round((MIN * 60 * 48000) / 128), Math.round(Number(process.env.F02_BLOCK_SECONDS ?? 60) * 48000 / 128));
  for (let i = 0; i < blocks; i++) { const s = performance.now(); core.renderBlock(o, 128); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  const budget = (128 / 48000) * 1000;
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = process.memoryUsage().heapUsed; let peak = h0;
  if (process.env.F02_SKIP_OFFLINE === '1') { mkdirSync('tests/artifacts/perf', { recursive: true }); writeFileSync(`tests/artifacts/perf/ablate-${ablate.join('+') || 'none'}.json`, JSON.stringify({ ablate, p50: +times[Math.floor(times.length * 0.5)].toFixed(3), p95: +times[Math.floor(times.length * 0.95)].toFixed(3), p99: +times[Math.floor(times.length * 0.99)].toFixed(3) })); return; }
  const t2 = performance.now(); let bytes = 0;
  const r = await renderToWav({ project: p, pcm, profile: 'balanced', blockFrames: 512, onProgress: () => { peak = Math.max(peak, process.memoryUsage().heapUsed); } }, { startTick: 0, endTick: MIN * 60 * 1920, sampleRate: 48000, format: 'wav-pcm24', tailSeconds: 2, seed: 20261022, allowFallbacks: false }, (c) => { bytes += c.length; });
  const renderMs = performance.now() - t2;
  if (!r.ok) throw new Error(r.message);
  const pcmMiB = [...pcm.values()].reduce((s, x) => s + x.frames * x.channels.length * 4, 0) / 2 ** 20;
  const result = {
    fixture: `F02-${VARIANT}${M5 ? '+M5' : ''}`, minutes: MIN, tracks: p.tracks.length, notes, clips, events: plan.events.count, automationLanes: p.automation.length,
    buildMs: Math.round(buildMs), compileMs: Math.round(compileMs), pcmMiB: +pcmMiB.toFixed(1),
    block128: { budgetMs: +budget.toFixed(3), p50: +times[Math.floor(times.length * 0.5)].toFixed(3), p95: +times[Math.floor(times.length * 0.95)].toFixed(3), p99: +times[Math.floor(times.length * 0.99)].toFixed(3), max: +times.at(-1)!.toFixed(3), p99OfBudget: +(times[Math.floor(times.length * 0.99)] / budget).toFixed(3), measuredSeconds: (blocks * 128) / 48000 },
    offline: { renderSec: +(renderMs / 1000).toFixed(1), realtimeFactor: +((MIN * 60) / (renderMs / 1000)).toFixed(2), outputMB: +(bytes / 1e6).toFixed(1), heapGrowthMiB: +((peak - h0) / 2 ** 20).toFixed(1), hash: r.receipt.outputAssetHash, diagnostics: r.receipt.diagnostics },
    environment: { node: process.version, arch: process.arch, platform: process.platform, note: 'Raspberry Pi 4B Node — not a real-time device result' },
  };
  console.log(JSON.stringify(result, null, 1));
  mkdirSync('tests/artifacts/perf', { recursive: true });
  writeFileSync(`tests/artifacts/perf/${result.fixture}-${MIN}min.json`, JSON.stringify(result, null, 1));
}, 3_600_000);
