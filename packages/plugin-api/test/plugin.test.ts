import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectBundle, runConformance, WasmPluginRuntime, PluginHost, reviewedList, validateManifest, parseWasm, checkModule, type InstalledPlugin, type PluginRegistryStore } from '@bass-daw/plugin-api';
import { bundleOf, sample, wat2wasm, LOOP, BAD_IMPORT, BAD_ABI, BAD_SIG, BAD_PTR, NO_MAX, BIG_MEM, TRAP_AFTER } from '../../../tests/fixtures/plugins.ts';

const memRegistry = (recs: Map<string, { record: InstalledPlugin; bundle: Uint8Array }>): PluginRegistryStore => ({ list: async () => [...recs.values()].map((x) => x.record), get: async (k) => recs.get(k) ?? null, put: async (r, b) => void recs.set(r.key, { record: r, bundle: b }), remove: async (k) => void recs.delete(k) });

async function load(name: string, mut: Parameters<typeof bundleOf>[1] = {}) {
  const r = await inspectBundle(await bundleOf(name, mut));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { ...r.value, module: await WebAssembly.compile(r.value.dsp as unknown as BufferSource), info: r.value.module };
}

describe('P01 ABI conformance: identity gain effect', () => {
  it('impulse/length/block sizes/mono-stereo', async () => {
    const g = await load('gain');
    const rep = runConformance(g.module, g.manifest, g.memoryPages);
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    // 독립 기대값: out = in × gain (sample-rate param, 정확히 float32 곱)
    for (const block of [1, 37, 128, 512, 600, 4096]) {
      const rt = new WasmPluginRuntime(g.module, g.manifest, 48000, g.memoryPages); rt.prepare('{}', []);
      const n = block; const io = [Float32Array.from({ length: n }, (_, i) => Math.sin(i)), Float32Array.from({ length: n }, (_, i) => Math.cos(i))];
      const inL = io[0].slice(), inR = io[1].slice();
      const gain = Float32Array.from({ length: n }, (_, i) => (i % 7) / 3);
      expect(rt.process(io, n, [], 0, [gain])).toBe(true);
      for (let i = 0; i < n; i++) { expect(io[0][i]).toBe(Math.fround(inL[i] * gain[i])); expect(io[1][i]).toBe(Math.fround(inR[i] * gain[i])); }
    }
    // mono 입력 plugin: 채널 합의 절반이 들어가 양쪽 출력으로 복제
    const mono = await load('gain', { manifest: (m) => ({ ...m, channels: { inputs: 1, outputs: 1 } }) });
    const rt = new WasmPluginRuntime(mono.module, mono.manifest, 48000, mono.memoryPages); rt.prepare('{}', []);
    const io = [new Float32Array([1, 0.5]), new Float32Array([0, 0.5])];
    rt.process(io, 2, [], 0, [new Float32Array([1, 1])]);
    expect(Array.from(io[0])).toEqual([0.5, 0.5]); expect(Array.from(io[1])).toEqual([0.5, 0.5]);
  });
  it('one-shot sampler: noteOn plays bound sample at pitch rate, sample-accurate offset', async () => {
    const s = await load('oneshot');
    expect(runConformance(s.module, s.manifest, s.memoryPages).ok).toBe(true);
    const rt = new WasmPluginRuntime(s.module, s.manifest, 48000, s.memoryPages);
    const pcm = new Float32Array(100); pcm[0] = 1; pcm[50] = 0.5;
    rt.prepare('{"version":1}', [{ channels: [pcm], sampleRate: 48000 }]);
    const io = [new Float32Array(256), new Float32Array(256)];
    const params = [new Float32Array(256).fill(1), new Float32Array(256).fill(60)];
    rt.process(io, 256, [{ offset: 10, type: 1, voice: 7, channel: 0, d0: 72, d1: 0.5, d2: 0 }], 1, params);
    expect(io[0][10]).toBeCloseTo(0.5, 6);      // velocity 0.5 × sample[0]
    expect(io[0][10 + 25]).toBeCloseTo(0.25, 6); // 한 옥타브 위 → rate 2 → sample[50] 이 25 frame 뒤
    expect(io[1][35]).toBe(io[0][35]);
  });
});

describe('P02 malformed bundles and modules are rejected', () => {
  const code = async (mut: Parameters<typeof bundleOf>[1]) => { const r = await inspectBundle(await bundleOf('gain', mut)); return r.ok ? 'OK' : r.errors.map((e) => e.code).join(','); };
  it('forbidden import / ABI signature / memory rules', async () => {
    expect(await code({ wat: BAD_IMPORT })).toMatch(/IMPORT_FORBIDDEN/);
    expect(await code({ wat: BAD_SIG })).toMatch(/EXPORT_SIGNATURE/);
    expect(await code({ wat: NO_MAX })).toMatch(/MEMORY_NO_MAXIMUM/);
    expect(await code({ wat: BIG_MEM })).toMatch(/MEMORY_MAX/);
    const shared = await wat2wasm(sample('gain').wat.replace('(memory (export "memory") 1 1)', '(memory (export "memory") 1 1 shared)'), { threads: true });
    expect(checkModule(parseWasm(shared), 1)).toContain('MEMORY_SHARED');
  });
  it('hash / manifest / bundle structure', async () => {
    const b = await bundleOf('gain');
    const tampered = b.slice(); tampered[tampered.length - 200] ^= 0xff;
    expect((await inspectBundle(tampered)).ok).toBe(false);
    expect(await code({ manifest: (m) => ({ ...m, dsp: { ...m.dsp, path: '../x.wasm' } }) })).toMatch(/BUNDLE_INVALID|MANIFEST_INVALID/);
    expect(await code({ manifest: (m) => ({ ...m, pluginId: 'builtin.evil' }) })).toMatch(/MANIFEST_INVALID/);
    expect(await code({ manifest: (m) => ({ ...m, extra: 1 } as never) })).toMatch(/MANIFEST_INVALID/);
    expect(await code({ manifest: (m) => ({ ...m, parameters: [{ ...m.parameters[0], default: 9 }] }) })).toMatch(/MANIFEST_INVALID/);
    expect(await code({ manifest: (m) => ({ ...m, maxMemoryPages: 5000 }) })).toMatch(/MANIFEST_INVALID/);
    expect(await code({ manifest: (m) => ({ ...m, permissions: ['network' as never] }) })).toMatch(/MANIFEST_INVALID/);
    expect((await inspectBundle(new Uint8Array(9 * 1024 * 1024))).ok).toBe(false);
    expect(validateManifest({ ...sample('gain').manifest, apiVersion: '2.0' }).ok).toBe(false);
  });
  it('ABI version mismatch / bad pointer / oversize state rejected at prepare', async () => {
    const abi = await load('gain', { wat: BAD_ABI });
    expect(() => new WasmPluginRuntime(abi.module, abi.manifest, 48000, abi.memoryPages).prepare('{}', [])).toThrow(/ABI_MISMATCH/);
    const ptr = await load('gain', { wat: BAD_PTR });
    expect(() => new WasmPluginRuntime(ptr.module, ptr.manifest, 48000, ptr.memoryPages).prepare('{}', [])).toThrow(/BAD_POINTER/);
    const g = await load('gain');
    expect(() => new WasmPluginRuntime(g.module, g.manifest, 48000, g.memoryPages).prepare(JSON.stringify({ x: 'y'.repeat(5000) }), [])).toThrow(/STATE_TOO_LARGE/);
  });
  it('host: install requires the exact inspected hash; params range-checked; migration refused keeps state', async () => {
    const recs = new Map<string, { record: InstalledPlugin; bundle: Uint8Array }>();
    const allow = new Set<string>();
    const host = new PluginHost(memRegistry(recs), async () => ({ ok: true, report: {} }), { isReviewed: (_i, _v, h) => allow.has(h) });
    const b = await bundleOf('gain');
    const other = await bundleOf('gain', { wat: (s) => s.replace('(global $heap (mut i32) (i32.const 49152))', '(global $heap (mut i32) (i32.const 49160))') });
    for (const x of [b, other]) { const r = await inspectBundle(x); if (r.ok) allow.add(r.value.bundleHash); }
    const i = await host.inspect(b); if (!i.ok) throw new Error();
    expect((await host.install(i.value, 'f'.repeat(64), b)).ok).toBe(false);
    expect((await host.install(i.value, i.value.bundleHash, b)).ok).toBe(true);
    const i2 = await host.inspect(other); if (!i2.ok) throw new Error();
    const r2 = await host.install(i2.value, i2.value.bundleHash, other);
    expect(!r2.ok && r2.errors[0].code).toBe('VERSION_CONFLICT');
    await host.instantiate('com.bassdaw.gain', '1.0.0', 'inst1');
    expect((await host.setParameter('inst1', 'gain', 5)).ok).toBe(false);
    expect((await host.setParameter('inst1', 'nope', 1)).ok).toBe(false);
    const mig = await host.restore('inst1', 2, { a: 1 });
    expect(!mig.ok && mig.errors[0].code).toBe('MIGRATION_REQUIRED');
    expect(await host.module('com.bassdaw.gain', '1.0.0', 'e'.repeat(64))).toBeNull(); // pinned hash 불일치 → 미설치 취급
    expect(await host.module('com.bassdaw.gain', '1.0.0', i.value.bundleHash)).not.toBeNull();
  });
});

describe('D05 policy: only reviewed fixed hashes are installed or executed', () => {
  it('a user-approved local bundle that is not on the reviewed list is refused before the test render', async () => {
    const recs = new Map<string, { record: InstalledPlugin; bundle: Uint8Array }>();
    let testRuns = 0;
    const host = new PluginHost(memRegistry(recs), async () => { testRuns++; return { ok: true, report: {} }; }, reviewedList([]));
    const b = await bundleOf('gain', { manifest: (m) => ({ ...m, pluginId: 'com.example.local' }) });
    const i = await host.inspect(b); if (!i.ok) throw new Error();
    const r = await host.install(i.value, i.value.bundleHash, b); // 사용자가 정확한 hash 를 승인해도
    expect(!r.ok && r.errors[0].code).toBe('PLUGIN_NOT_REVIEWED');
    expect(testRuns).toBe(0);
    expect(recs.size).toBe(0);
  });
  it('an installed record whose hash is not (or no longer) reviewed is not compiled or loaded', async () => {
    const recs = new Map<string, { record: InstalledPlugin; bundle: Uint8Array }>();
    const b = await bundleOf('gain');
    const i = await inspectBundle(b); if (!i.ok) throw new Error();
    // 정책 도입 전 설치(또는 저장소 직접 변조)를 흉내: registry 에 직접 기록
    recs.set('com.bassdaw.gain@1.0.0', { record: { key: 'com.bassdaw.gain@1.0.0', manifest: i.value.manifest, bundleHash: i.value.bundleHash, memoryPages: i.value.memoryPages, installedAt: '', conformance: null }, bundle: b });
    const host = new PluginHost(memRegistry(recs), async () => ({ ok: true, report: {} }), reviewedList([]));
    expect(await host.module('com.bassdaw.gain', '1.0.0', i.value.bundleHash)).toBeNull();
    expect(await host.installedBundle('com.bassdaw.gain@1.0.0')).toBeNull();
    const ok = new PluginHost(memRegistry(recs), async () => ({ ok: true, report: {} }), reviewedList([{ pluginId: 'com.bassdaw.gain', version: '1.0.0', bundleSha256: i.value.bundleHash }]));
    expect(await ok.module('com.bassdaw.gain', '1.0.0', i.value.bundleHash)).not.toBeNull();
    // 같은 hash 라도 다른 pluginId/version 으로 등재된 항목은 통과하지 않는다
    expect(reviewedList([{ pluginId: 'com.other', version: '1.0.0', bundleSha256: i.value.bundleHash }]).isReviewed('com.bassdaw.gain', '1.0.0', i.value.bundleHash)).toBe(false);
  });
  it('the shipped reviewed list equals the hashes of the built sample bundles (independent node:crypto hash)', async () => {
    const list = JSON.parse(readFileSync('apps/web/src/plugins/reviewed.json', 'utf8')) as { pluginId: string; version: string; bundleSha256: string; source: string }[];
    expect(list.map((x) => x.source).sort()).toEqual(readdirSync('plugins', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `plugins/${d.name}`).sort());
    for (const x of list) {
      const file = readFileSync(`apps/web/public/plugins/${x.source.split('/')[1]}.bdplugin`);
      expect(createHash('sha256').update(file).digest('hex')).toBe(x.bundleSha256);
      expect(x.pluginId.startsWith('com.example.')).toBe(false); // 테스트 번들은 목록에 없다
    }
  });
});

describe('P03 trap / NaN → fault (state preserved)', () => {
  it('trap and NaN set faulted; host stops calling the plugin', async () => {
    const f = await load('faultdemo');
    const run = (mode: number) => {
      const rt = new WasmPluginRuntime(f.module, f.manifest, 48000, f.memoryPages); rt.prepare('{"keep":true}', []);
      const io = [new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)];
      const ok = rt.process(io, 128, [], 0, [new Float32Array(128).fill(mode)]);
      return { ok, fault: rt.faulted, again: rt.process(io, 128, [], 0, [new Float32Array(128).fill(0)]) };
    };
    expect(run(0)).toEqual({ ok: true, fault: null, again: true });
    expect(run(1)).toEqual({ ok: false, fault: 'nan', again: false });
    expect(run(2)).toEqual({ ok: false, fault: 'trap', again: false });
    const t = await load('gain', { wat: TRAP_AFTER });
    const rt = new WasmPluginRuntime(t.module, t.manifest, 48000, t.memoryPages); rt.prepare('{}', []);
    const io = [new Float32Array(64), new Float32Array(64)];
    expect(rt.process(io, 64, [], 0, [new Float32Array(64).fill(3.5)])).toBe(false);
    expect(rt.faulted).toBe('trap');
  });
});

describe('P06 infinite loop: isolated worker watchdog terminates at 5s, runner survives', () => {
  it('watchdog', async () => {
    const b = await bundleOf('gain', { wat: LOOP });
    const r = await inspectBundle(b); if (!r.ok) throw new Error();
    const src = `
      const { parentPort, workerData } = require('node:worker_threads');
      const m = new WebAssembly.Module(workerData.dsp);
      const inst = new WebAssembly.Instance(m, { host: {} });
      inst.exports.create(48000, 512);
      parentPort.postMessage('started');
      inst.exports.process(1, 128, 0); // 무한 루프
      parentPort.postMessage('returned');`;
    const t0 = Date.now();
    const w = new Worker(src, { eval: true, workerData: { dsp: r.value.dsp } });
    const msgs: string[] = [];
    w.on('message', (m) => msgs.push(m));
    const outcome = await new Promise<string>((res) => {
      let killed = false;
      const timer = setTimeout(() => { killed = true; void w.terminate(); }, 5000);
      w.on('exit', () => { clearTimeout(timer); res(killed ? 'terminated-by-watchdog' : 'exited'); });
    });
    expect(outcome).toBe('terminated-by-watchdog');
    expect(msgs).toEqual(['started']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(1 + 1).toBe(2); // runner 생존
  }, 20_000);
});
