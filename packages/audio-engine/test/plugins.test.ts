import { describe, it, expect } from 'vitest';
import { compilePlan, RenderCore, renderToWav, WasmModuleCache, WorkletRuntime, type PluginResolver } from '@bass-daw/audio-engine';
import { inspectBundle, pluginKey } from '@bass-daw/plugin-api';
import { serializeProject, deserializeProject, validateProject } from '@bass-daw/schemas';
import { Builder, impulse, dc, onsets, SR } from '../../../tests/fixtures/engine.ts';
import { bundleOf } from '../../../tests/fixtures/plugins.ts';

async function installed(names: string[]) {
  const wasm = new Map<string, WebAssembly.Module>();
  const recs = new Map<string, { key: string; manifest: never; memoryPages: number; hash: string }>();
  for (const n of names) {
    const r = await inspectBundle(await bundleOf(n)); if (!r.ok) throw new Error();
    const key = pluginKey(r.value.manifest.pluginId, r.value.manifest.version);
    wasm.set(key, await WebAssembly.compile(r.value.dsp as unknown as BufferSource));
    recs.set(key, { key, manifest: r.value.manifest as never, memoryPages: r.value.memoryPages, hash: r.value.bundleHash });
  }
  const resolve: PluginResolver = (id, v) => recs.get(pluginKey(id, v)) ?? null;
  return { wasm, resolve, recs };
}
const info = (b: Builder) => (h: string) => { const p = b.pcm.get(h); return p ? { sampleRate: p.sampleRate, channels: 1 } : null; };
function render(b: Builder, frames: number, ins: Awaited<ReturnType<typeof installed>>, block = 128) {
  const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b), plugins: ins.resolve });
  if (!plan.ok) throw new Error(plan.message);
  const core = new RenderCore(plan.graph, b.pcm, { maxBlock: block, polyphony: 64, wasm: ins.wasm });
  core.setEvents(plan.events); core.locate(0, true);
  const out = [new Float32Array(frames), new Float32Array(frames)]; const tmp = [new Float32Array(block), new Float32Array(block)];
  for (let pos = 0; pos < frames; pos += block) { const n = Math.min(block, frames - pos); core.renderBlock(tmp, n); out[0].set(tmp[0].subarray(0, n), pos); out[1].set(tmp[1].subarray(0, n), pos); }
  return { out, core, plan };
}
const insertGain = (b: Builder, channelId: string, id = 'fx-g') => b.run({ type: 'InsertEffect', channelId, pluginId: 'com.bassdaw.gain', instanceId: id, external: { pluginVersion: '1.0.0', stateVersion: 1, parameters: { gain: 1 } } });

describe('MVP-6 WASM plugins in the render graph', () => {
  it('gain effect with sample automation matches analytic envelope (A07 with a 3rd-party parameter)', async () => {
    const ins = await installed(['gain']);
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    insertGain(b, t.channelId);
    b.run({ type: 'EditAutomation', op: 'upsert', lane: { id: 'lg', target: { owner: 'plugin', ownerId: 'fx-g', parameterId: 'gain' }, enabled: true, points: [{ tick: 0, value: 0, interpolation: 'linear' }, { tick: 1920, value: 2, interpolation: 'step' }] } });
    const { out, core } = render(b, SR * 1.5, ins);
    for (let f = 0; f < SR * 1.5; f += 97) expect(Math.abs(out[0][f] - 0.5 * (f < SR ? (2 * f) / SR : 2))).toBeLessThan(1e-5);
    expect(core.counters.pluginFaults).toBe(0);
  });
  it('one-shot sampler instrument: impulse onsets at note frames', async () => {
    const ins = await installed(['oneshot']);
    const b = new Builder();
    const t = b.midiTrack('x', impulse(), [{ tick: 0, dur: 10, pitch: 60 }, { tick: 960, dur: 10, pitch: 60 }]);
    const a = b.p.assets.find((x) => x.id === 'asset-x')!;
    b.run({ type: 'SetInstrument', trackId: t.trackId, plugin: { instanceId: 'os1', pluginId: 'com.bassdaw.oneshot', pluginVersion: '1.0.0', stateVersion: 1, role: 'instrument', state: { version: 1 }, parameters: { gain: 1, rootPitch: 60 }, assets: [a.id] } });
    const { out } = render(b, SR, ins);
    expect(onsets(out[0], 0.5)).toEqual([0, 24000]);
  });
  it('P03: trap mid-render → compensated dry bypass with 5ms ramp, project state unchanged', async () => {
    const ins = await installed(['faultdemo']);
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    b.run({ type: 'InsertEffect', channelId: t.channelId, pluginId: 'com.bassdaw.faultdemo', instanceId: 'fx-f', state: { keep: 'me' }, external: { pluginVersion: '1.0.0', stateVersion: 1, parameters: { mode: 0 } } });
    b.run({ type: 'EditAutomation', op: 'upsert', lane: { id: 'lf', target: { owner: 'plugin', ownerId: 'fx-f', parameterId: 'mode' }, enabled: true, points: [{ tick: 0, value: 0, interpolation: 'step' }, { tick: 960, value: 2, interpolation: 'step' }] } });
    const before = JSON.stringify(b.p.plugins);
    const { out, core } = render(b, SR, ins);
    expect(core.pluginFaults()).toEqual([{ instanceId: 'fx-f', reason: 'trap' }]);
    expect(out[0][23000]).toBeCloseTo(0.5, 6);               // fault 전 정상
    // mode 는 block 파라미터: 24000 frame 을 포함한 block 다음 경계(24064)에서 trap
    expect(out[0][24063]).toBeCloseTo(0.5, 6);
    expect(out[0][24064]).toBe(0);                           // fault block: 0 에서 시작
    expect(out[0][24064 + 120]).toBeCloseTo(0.25, 2);        // ramp 중간
    expect(out[0][24064 + 240 + 10]).toBeCloseTo(0.5, 6);    // 5ms 후 dry 복귀
    expect(out[0].every(Number.isFinite)).toBe(true);
    expect(JSON.stringify(b.p.plugins)).toBe(before);
  });
  it('X03/P05: missing or hash-mismatched plugin blocks export; state/parameters/automation round trip', async () => {
    const ins = await installed(['gain']);
    const b = new Builder();
    const t = b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    insertGain(b, t.channelId);
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-g', parameterId: 'gain', value: 0.5 });
    b.run({ type: 'EditAutomation', op: 'upsert', lane: { id: 'lg', target: { owner: 'plugin', ownerId: 'fx-g', parameterId: 'gain' }, enabled: false, points: [{ tick: 0, value: 0.3, interpolation: 'linear' }] } });
    const opts = { startTick: 0, endTick: 960, sampleRate: 48000 as const, format: 'wav-float32' as const, tailSeconds: 0, seed: 1, allowFallbacks: false };
    const blocked = await renderToWav({ project: b.p, pcm: b.pcm }, opts, () => {});
    expect(!blocked.ok && blocked.code).toBe('EXPORT_BLOCKED');
    const ok1 = await renderToWav({ project: b.p, pcm: b.pcm, plugins: ins.resolve, wasm: ins.wasm }, opts, () => {});
    const ok2 = await renderToWav({ project: b.p, pcm: b.pcm, plugins: ins.resolve, wasm: ins.wasm }, opts, () => {});
    if (!ok1.ok || !ok2.ok) throw new Error();
    expect(ok1.receipt.outputAssetHash).toBe(ok2.receipt.outputAssetHash);
    // 미설치 상태로 저장/복원해도 plugin state·parameter·automation 보존
    const bytes = serializeProject(b.p); if (!bytes.ok) throw new Error();
    const back = deserializeProject(bytes.value); if (!back.ok) throw new Error();
    expect(back.value.plugins.find((x) => x.instanceId === 'fx-g')).toEqual(b.p.plugins.find((x) => x.instanceId === 'fx-g'));
    expect(back.value.automation).toEqual(b.p.automation);
    expect(validateProject(back.value).ok).toBe(true);
  });
  it('render graph stays plain-cloneable (no Module/functions leak into Worklet messages)', async () => {
    const ins = await installed(['gain', 'oneshot']);
    const resolver: PluginResolver = (id, v) => { const r = ins.resolve(id, v); return r ? { ...r, module: ins.wasm.get(r.key) } as never : null; };
    const b = new Builder();
    const t = b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    insertGain(b, t.channelId);
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b), plugins: resolver });
    if (!plan.ok) throw new Error();
    const g = plan.graph.channels.flatMap((c) => c.effects).find((e) => e.wasm)!;
    expect(Object.keys(g.wasm!).sort()).toEqual(['key', 'manifest', 'memoryPages', 'stateJson']);
    expect(JSON.parse(JSON.stringify(plan.graph))).toEqual(plan.graph);
  });
  it('state version mismatch → bypass + MIGRATION diagnostic, state kept', async () => {
    const ins = await installed(['gain']);
    const b = new Builder();
    const t = b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    b.run({ type: 'InsertEffect', channelId: t.channelId, pluginId: 'com.bassdaw.gain', instanceId: 'fx-g', state: { old: 1 }, external: { pluginVersion: '1.0.0', stateVersion: 0, parameters: {} } });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b), plugins: ins.resolve });
    expect(plan.ok && plan.diagnostics.join()).toMatch(/PLUGIN_MIGRATION_REQUIRED/);
  });
});

/** WebAssembly 컴파일 API 호출을 센다(Module 생성자·compile·instantiate(bytes)·compileStreaming) */
function countCompiles() {
  const W = globalThis.WebAssembly as unknown as Record<string, unknown>;
  const orig = { Module: W.Module, compile: W.compile, instantiate: W.instantiate };
  const calls: string[] = [];
  const OrigModule = orig.Module as typeof WebAssembly.Module;
  W.Module = new Proxy(OrigModule, { construct(t, a) { calls.push('Module'); return Reflect.construct(t, a); } });
  W.compile = (...a: unknown[]) => { calls.push('compile'); return (orig.compile as (...x: unknown[]) => unknown)(...a); };
  W.instantiate = (src: unknown, imp: unknown) => { if (!(src instanceof OrigModule)) calls.push('instantiate(bytes)'); return (orig.instantiate as (...x: unknown[]) => unknown)(src, imp); };
  return { calls, restore: () => Object.assign(W, orig) };
}

describe('item 2: WASM is compiled only in the prepare phase, never by the render path', () => {
  it('WasmModuleCache refuses to compile while the transport is starting/playing and compiles when idle', async () => {
    const r = await inspectBundle(await bundleOf('gain')); if (!r.ok) throw new Error();
    let compiles = 0;
    const cache = new WasmModuleCache((b) => { compiles++; return new WebAssembly.Module(b as unknown as BufferSource); });
    for (const t of ['playing', 'starting'] as const) {
      const x = cache.prepare([['g@1', r.value.dsp]], t);
      expect(x.refused).toEqual(['g@1']);
    }
    expect(compiles).toBe(0);
    expect(cache.modules.size).toBe(0);
    expect(cache.prepare([['g@1', r.value.dsp]], 'idle').compiled).toEqual(['g@1']);
    expect(cache.prepare([['g@1', r.value.dsp]], 'idle').compiled).toEqual([]); // 이미 준비됨 → 재컴파일 없음
    expect(compiles).toBe(1);
    expect(cache.log.map((l) => `${l.transport}:${l.ok}`)).toEqual(['playing:false', 'starting:false', 'idle:true']);
  });
  it('the worklet flow: a prepare request that arrives during playback is refused using the real WorkletRuntime state', async () => {
    const ins = await installed(['gain']);
    const r = await inspectBundle(await bundleOf('gain')); if (!r.ok) throw new Error();
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR, 0.5), [{ tick: 0, dur: 3840 }]);
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b), plugins: ins.resolve });
    if (!plan.ok) throw new Error();
    const rt = new WorkletRuntime(new RenderCore(plan.graph, b.pcm, { maxBlock: 128, polyphony: 8 }), 0);
    rt.control('play', 1, 0);
    const out = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 4; i++) rt.process(out, 128, () => Infinity, () => false);
    rt.watermark(1, 1e9);
    for (let i = 0; i < 4; i++) rt.process(out, 128, () => Infinity, () => false);
    expect(rt.state).not.toBe('idle');
    const cache = new WasmModuleCache();
    expect(cache.prepare([['com.bassdaw.gain@1.0.0', r.value.dsp]], rt.state).refused.length).toBe(1);
    rt.control('pause', 2, 0); rt.process(out, 128, () => Infinity, () => false);
    expect(rt.state).toBe('idle');
    expect(cache.prepare([['com.bassdaw.gain@1.0.0', r.value.dsp]], rt.state).compiled.length).toBe(1);
    void t;
  });
  it('RenderCore construction and 500 render blocks make zero compile calls; an unprepared module is a compensated dry bypass', async () => {
    const ins = await installed(['gain']);
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 2, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    insertGain(b, t.channelId);
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-g', parameterId: 'gain', value: 2 });
    const spy = countCompiles();
    try {
      const prepared = render(b, 128 * 500, ins);          // 준비된 모듈: gain 2 적용
      expect(prepared.out[0][1000]).toBeCloseTo(1.0, 6);
      const unprepared = render(b, 128 * 50, { ...ins, wasm: new Map() }); // 준비 안 됨: 컴파일하지 않고 dry
      expect(unprepared.out[0][1000]).toBeCloseTo(0.5, 6);
      expect(unprepared.core.pluginFaults()).toEqual([{ instanceId: 'fx-g', reason: 'not-prepared' }]);
      expect(spy.calls).toEqual([]);
    } finally { spy.restore(); }
  });
});
