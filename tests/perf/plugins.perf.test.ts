// PERF=1: 플러그인별 128-frame process 시간·메모리(Pi Node 참고치, 03 §6 "plugin 1개 ≤ block budget 20% p99")
import { it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { inspectBundle, WasmPluginRuntime, type PluginEvent } from '@bass-daw/plugin-api';
import { bundleOf } from '../fixtures/plugins.ts';

it.runIf(process.env.PERF === '1')('plugin budgets', async () => {
  const out: Record<string, unknown>[] = [];
  const budget = (128 / 48000) * 1000;
  for (const name of ['gain', 'oneshot', 'faultdemo']) {
    const r = await inspectBundle(await bundleOf(name)); if (!r.ok) throw new Error();
    const m = r.value.manifest;
    const rt = new WasmPluginRuntime(await WebAssembly.compile(r.value.dsp as never), m, 48000, r.value.memoryPages);
    rt.prepare('{}', m.role === 'instrument' ? [{ channels: [Float32Array.from({ length: 96000 }, (_, i) => Math.sin(i / 20))], sampleRate: 48000 }] : []);
    const io = [new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)];
    const params = m.parameters.map((d) => new Float32Array(128).fill(d.default));
    const t: number[] = [];
    for (let i = 0; i < 20000; i++) {
      const ev: PluginEvent[] = m.role === 'instrument' && i % 4 === 0 ? [{ offset: 0, type: 1, voice: i, channel: 0, d0: 48 + (i % 24), d1: 0.8, d2: 0 }] : [];
      const s = performance.now(); rt.process(io, 128, ev, ev.length, params); t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    out.push({ plugin: `${m.pluginId}@${m.version}`, memoryMiB: (r.value.memoryPages * 65536) / 2 ** 20, p50ms: +t[10000].toFixed(4), p99ms: +t[19800].toFixed(4), p99OfBudget: +(t[19800] / budget).toFixed(3), note: m.role === 'instrument' ? '8 voices sounding' : '' });
  }
  mkdirSync('tests/artifacts/perf', { recursive: true });
  writeFileSync('tests/artifacts/perf/plugins.json', JSON.stringify({ env: 'Pi 4B Node v24 (reference, not a device result)', budgetMs: budget, plugins: out }, null, 1));
}, 120_000);
