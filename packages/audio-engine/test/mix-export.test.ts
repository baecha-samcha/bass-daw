import { describe, it, expect } from 'vitest';
import { compilePlan, RenderCore, renderToWav, Biquad, EqDsp, CompressorDsp, ReverbDsp, decodeWav, type ExportOptions } from '@bass-daw/audio-engine';
import { exportMidi, importMidi } from '@bass-daw/midi-engine';
import { compileTabSource } from '@bass-daw/tab-engine';
import { Builder, impulse, dc, onsets, SR } from '../../../tests/fixtures/engine.ts';
import { parseWav } from '../../../tests/fixtures/wavparse.ts';
import { parseSmf } from '../../../tests/fixtures/midiparse.ts';
import { f03 } from '../../../tests/fixtures/projects.ts';
import { createHash } from 'node:crypto';

const info = (b: Builder) => (h: string) => { const p = b.pcm.get(h); return p ? { sampleRate: p.sampleRate, channels: 1 } : null; };
function render(b: Builder, frames: number, block = 128): Float32Array[] {
  const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
  if (!plan.ok) throw new Error(plan.message);
  const core = new RenderCore(plan.graph, b.pcm, { maxBlock: block, polyphony: 64 });
  core.setEvents(plan.events); core.locate(0, true);
  const out = [new Float32Array(frames), new Float32Array(frames)]; const tmp = [new Float32Array(block), new Float32Array(block)];
  for (let pos = 0; pos < frames; pos += block) { const n = Math.min(block, frames - pos); core.renderBlock(tmp, n); out[0].set(tmp[0].subarray(0, n), pos); out[1].set(tmp[1].subarray(0, n), pos); }
  return out;
}
async function wav(b: Builder, opts: Partial<ExportOptions> = {}) {
  const chunks: Uint8Array[] = [];
  const r = await renderToWav({ project: b.p, pcm: b.pcm }, { startTick: 0, endTick: 3840, sampleRate: 48000, format: 'wav-pcm24', tailSeconds: 0, seed: 20261022, allowFallbacks: false, ...opts }, (c) => { chunks.push(c.slice()); });
  const total = chunks.reduce((s, c) => s + c.length, 0); const bytes = new Uint8Array(total); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
  return { r, bytes };
}
const lane = (id: string, owner: 'channel' | 'plugin', ownerId: string, parameterId: string, points: [number, number, 'step' | 'linear'][]) =>
  ({ type: 'EditAutomation' as const, op: 'upsert' as const, lane: { id, target: { owner, ownerId, parameterId }, enabled: true, points: points.map(([tick, value, interpolation]) => ({ tick, value, interpolation })) } });

describe('A07 automation (independent analytic envelope)', () => {
  it('channel gain linear ramp + step, sample-accurate', () => {
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    // 0→1 linear over tick 0..1920 (1s), step 0.25 at 1920, 유지
    b.run(lane('l1', 'channel', t.channelId, 'gain', [[0, 0, 'linear'], [1920, 1, 'step'], [2880, 0.25, 'linear']]));
    const out = render(b, SR * 2, 128);
    const env = (f: number) => (f < 48000 ? f / 48000 : f < 72000 ? 1 : 0.25);
    let maxErr = 0;
    for (let f = 0; f < SR * 2; f += 7) maxErr = Math.max(maxErr, Math.abs(out[0][f] - 0.5 * env(f)));
    expect(maxErr).toBeLessThan(1e-6);
  });
  it('before first point uses stored parameter value; manual change with no lane smooths over 5ms only', () => {
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    b.run({ type: 'SetParameter', owner: 'channel', ownerId: t.channelId, parameterId: 'gain', value: 0.5 });
    b.run(lane('l1', 'channel', t.channelId, 'gain', [[960, 1, 'step']]));
    const out = render(b, SR);
    expect(out[0][1000]).toBeCloseTo(0.25, 6);
    expect(out[0][24000 + 10]).toBeCloseTo(0.5, 6);
  });
  it('plugin parameter automation (sampler gain)', () => {
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    b.run(lane('l2', 'plugin', t.instanceId, 'gain', [[0, 2, 'linear'], [960, 0, 'linear']]));
    const out = render(b, SR);
    expect(out[0][12000]).toBeCloseTo(0.5 * 1.0, 5);
  });
});

describe('A08 PDC: impulse alignment across bus/send paths', () => {
  it('direct path vs compressor-lookahead bus vs reverb send arrive on the same frame', () => {
    const b = new Builder();
    const a = b.midiTrack('a', impulse(), [{ tick: 960, dur: 10 }]);
    const c = b.midiTrack('c', impulse(), [{ tick: 960, dur: 10 }]);
    b.run({ type: 'CreateBus', name: 'Comp', busId: 'bus-comp' });
    b.run({ type: 'InsertEffect', channelId: 'bus-comp', pluginId: 'builtin.compressor', instanceId: 'fx-comp' });
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-comp', parameterId: 'lookaheadMs', value: 10 });
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-comp', parameterId: 'thresholdDb', value: 0 });
    b.run({ type: 'SetRouting', channelId: c.channelId, output: 'bus-comp' });
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    if (!plan.ok) throw new Error();
    expect(plan.graph.totalLatency).toBe(480);
    // 채널별 PDC: a 는 480 지연, c 는 bus 의 480 lookahead
    const solo = (name: 'a' | 'c') => {
      const bb = new Builder(); Object.assign(bb, { s: b.s, pcm: b.pcm });
      bb.run({ type: 'SetChannelFlags', channelId: (name === 'a' ? c : a).channelId, muted: true });
      const o = render(bb, SR); bb.s.undo(); return onsets(o[0], 0.2);
    };
    const pa = solo('a'), pc = solo('c');
    expect(pa).toEqual([24000 + 480]);
    expect(pc.length).toBe(1);
    expect(Math.abs(pa[0] - pc[0])).toBeLessThanOrEqual(1);
  });
  it('rejects graphs needing more than 2s compensation', () => {
    const b = new Builder();
    const a = b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    let prev = a.channelId;
    for (let i = 0; i < 110; i++) {
      b.run({ type: 'CreateBus', name: `b${i}`, busId: `bus-${i}` });
      b.run({ type: 'InsertEffect', channelId: `bus-${i}`, pluginId: 'builtin.compressor', instanceId: `fx-${i}` });
      b.run({ type: 'SetParameter', owner: 'plugin', ownerId: `fx-${i}`, parameterId: 'lookaheadMs', value: 20 });
      b.run({ type: 'SetRouting', channelId: prev, output: `bus-${i}` });
      prev = `bus-${i}`;
    }
    const plan = compilePlan(b.p, { sampleRate: SR, assetInfo: info(b) });
    expect(!plan.ok && plan.code).toBe('PDC_LIMIT');
  });
});

describe('mixer routing: pre/post sends, mute, solo', () => {
  function setup() {
    const b = new Builder();
    const a = b.midiTrack('a', dc(SR * 2, 0.5), [{ tick: 0, dur: 3840 }], { loop: [10, 90000] });
    b.run({ type: 'CreateBus', name: 'FX', busId: 'bus-fx' });
    return { b, a };
  }
  it('post send follows fader, pre send ignores fader; bus sums', () => {
    const { b, a } = setup();
    b.run({ type: 'SetRouting', channelId: a.channelId, sends: [{ id: 's1', targetChannelId: 'bus-fx', gain: 1, tap: 'post' }] });
    b.run({ type: 'SetParameter', owner: 'channel', ownerId: a.channelId, parameterId: 'gain', value: 0.5 });
    let o = render(b, 4800); expect(o[0][4000]).toBeCloseTo(0.25 + 0.25, 5);
    b.run({ type: 'SetRouting', channelId: a.channelId, sends: [{ id: 's1', targetChannelId: 'bus-fx', gain: 1, tap: 'pre' }] });
    o = render(b, 4800); expect(o[0][4000]).toBeCloseTo(0.25 + 0.5, 5);
  });
  it('mute blocks output and sends; solo silences other source tracks but keeps soloed bus sources', () => {
    const { b, a } = setup();
    const k = b.midiTrack('k', dc(SR * 2, 0.25), [{ tick: 0, dur: 3840 }], { loop: [10, 90000] });
    b.run({ type: 'SetRouting', channelId: a.channelId, sends: [{ id: 's1', targetChannelId: 'bus-fx', gain: 1, tap: 'pre' }] });
    b.run({ type: 'SetChannelFlags', channelId: a.channelId, muted: true });
    expect(render(b, 4800)[0][4000]).toBeCloseTo(0.25, 5);
    b.s.undo();
    b.run({ type: 'SetChannelFlags', channelId: k.channelId, solo: true });
    expect(render(b, 4800)[0][4000]).toBeCloseTo(0.25, 5);
    b.s.undo();
    b.run({ type: 'SetChannelFlags', channelId: 'bus-fx', solo: true });
    expect(render(b, 4800)[0][4000]).toBeCloseTo(0.5 + 0.5, 5); // a 는 soloed bus 로 가므로 살아있음, k 차단
  });
  it('mono constant-power pan: center unity, hard left √2/0', () => {
    const { b, a } = setup();
    b.run({ type: 'SetParameter', owner: 'channel', ownerId: a.channelId, parameterId: 'pan', value: -1 });
    const o = render(b, 4800);
    expect(o[0][4000]).toBeCloseTo(0.5 * Math.SQRT2, 5);
    expect(Math.abs(o[1][4000])).toBeLessThan(1e-6);
  });
});

describe('builtin effects characteristics', () => {
  it('EQ peaking band: gain at center frequency matches dB, unity far away, frequency clamped below Nyquist', () => {
    const bq = new Biquad(); bq.setPeaking(48000, 1000, 6, 1);
    expect(20 * Math.log10(bq.magnitude(48000, 1000))).toBeCloseTo(6, 3);
    expect(20 * Math.log10(bq.magnitude(48000, 20))).toBeCloseTo(0, 1);
    const eq = new EqDsp(48000);
    const io = [new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)];
    const params = [30000, 3, 1, 1000, 0, 0.7, 8000, 0, 0.7].map((v) => new Float32Array(128).fill(v));
    eq.process(io, 128, params);
    expect(eq.diagnostics[0]).toMatch(/EQ_FREQ_CLAMPED/);
    expect(io[0].every(Number.isFinite)).toBe(true);
  });
  it('compressor: steady-state gain reduction = (lvl-thr)(1-1/ratio), lookahead latency exact', () => {
    const c = new CompressorDsp(48000, 5);
    expect(c.latencyFrames).toBe(240);
    const params = [-20, 4, 1, 50, 0, 5].map((v) => new Float32Array(512).fill(v));
    const io = [new Float32Array(512), new Float32Array(512)];
    for (let k = 0; k < 400; k++) { io[0].fill(0.5); io[1].fill(0.5); c.process(io, 512, params); }
    const lvl = 20 * Math.log10(0.5); const expectGr = (lvl + 20) * (1 - 1 / 4);
    expect(c.gainReductionDb).toBeCloseTo(expectGr, 2);
    expect(20 * Math.log10(io[0][511] / 0.5)).toBeCloseTo(-expectGr, 2);
  });
  it('reverb: impulse response = dry delayed by partition + IR wet; finite; tail length', () => {
    const ir = [new Float32Array(1000), new Float32Array(1000)]; ir[0][10] = 0.5; ir[1][300] = 0.25;
    const r = new ReverbDsp(48000, ir, 0);
    const io = [new Float32Array(4096), new Float32Array(4096)]; io[0][0] = 1; io[1][0] = 1;
    const params = [new Float32Array(4096).fill(1), new Float32Array(4096).fill(1)];
    r.process(io, 4096, params);
    const L = r.latencyFrames;
    expect(L).toBe(2048);
    expect(io[0][L]).toBeCloseTo(1, 6); expect(io[0][L + 10]).toBeCloseTo(0.5, 5);
    expect(io[1][L + 300]).toBeCloseTo(0.25, 5);
    expect(Math.abs(io[0][L + 11])).toBeLessThan(1e-6);
    expect(io[0].every(Number.isFinite)).toBe(true);
    expect(r.tailFrames).toBe(1000 + L);
  });
});

describe('A09 offline: seeded repeat, tail, latency removal', () => {
  function proj() {
    const b = new Builder();
    const a = b.midiTrack('a', impulse(), [{ tick: 960, dur: 10 }, { tick: 3600, dur: 10 }]);
    b.run({ type: 'InsertEffect', channelId: a.channelId, pluginId: 'builtin.reverb', instanceId: 'fx-rev' });
    b.run({ type: 'InsertEffect', channelId: a.channelId, pluginId: 'builtin.compressor', instanceId: 'fx-c' });
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-c', parameterId: 'lookaheadMs', value: 3 });
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-c', parameterId: 'thresholdDb', value: 0 });
    b.run({ type: 'SetParameter', owner: 'plugin', ownerId: 'fx-rev', parameterId: 'wet', value: 0.5 });
    return b;
  }
  it('same seed → identical bytes/hash; latency pre-roll removed exactly; tail rendered', async () => {
    const x = await wav(proj(), { format: 'wav-float32', tailSeconds: 1.5 });
    const y = await wav(proj(), { format: 'wav-float32', tailSeconds: 1.5 });
    if (!x.r.ok || !y.r.ok) throw new Error();
    expect(x.r.receipt.outputAssetHash).toBe(y.r.receipt.outputAssetHash);
    expect(createHash('sha256').update(x.bytes).digest('hex')).toBe(x.r.receipt.outputAssetHash);
    const w = parseWav(x.bytes);
    expect(w.frames).toBe(96000 + 72000);
    // dry impulse at exactly tick 960 = frame 24000 despite 128+144 latency
    let first = -1; for (let i = 0; i < w.frames; i++) if (Math.abs(w.sample(i, 0)) > 0.3) { first = i; break; }
    expect(first).toBe(24000);
    // tail: 곡 끝(96000) 이후에도 reverb 잔향 존재
    let tailEnergy = 0; for (let i = 96000; i < 96000 + 24000; i++) tailEnergy += Math.abs(w.sample(i, 0));
    expect(tailEnergy).toBeGreaterThan(0);
  });
  it('pcm24 dither depends on seed only', async () => {
    const a = await wav(proj(), { seed: 1 }); const b2 = await wav(proj(), { seed: 1 }); const c = await wav(proj(), { seed: 2 });
    if (!a.r.ok || !b2.r.ok || !c.r.ok) throw new Error();
    expect(a.r.receipt.outputAssetHash).toBe(b2.r.receipt.outputAssetHash);
    expect(a.r.receipt.outputAssetHash).not.toBe(c.r.receipt.outputAssetHash);
  });
});

describe('X01 WAV header / frames / clamp / dither (independent byte parser)', () => {
  it('pcm24: header fields, exact frame count, clamp of overdriven signal', async () => {
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.9), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    b.run({ type: 'SetParameter', owner: 'channel', ownerId: t.channelId, parameterId: 'gain', value: 3 });
    const { r, bytes } = await wav(b, { endTick: 1920, tailSeconds: 0.25 });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const w = parseWav(bytes);
    expect([w.fmt, w.ch, w.rate, w.bits, w.align, w.byteRate]).toEqual([1, 2, 48000, 24, 6, 288000]);
    expect(w.frames).toBe(48000 + 12000);
    expect(w.riffLen).toBe(w.total - 8);
    expect(w.dataLen).toBe(w.frames * 6);
    expect(w.sample(1000, 0)).toBe(8388607);
    expect(r.receipt.clipped).toBeGreaterThan(0);
    expect(r.receipt.diagnostics.join()).toMatch(/CLAMPED/);
  });
  it('float32 is not clipped or normalized', async () => {
    const b = new Builder();
    const t = b.midiTrack('dc', dc(SR * 3, 0.9), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    b.run({ type: 'SetParameter', owner: 'channel', ownerId: t.channelId, parameterId: 'gain', value: 3 });
    const { r, bytes } = await wav(b, { format: 'wav-float32', endTick: 960 });
    if (!r.ok) throw new Error();
    const w = parseWav(bytes);
    expect(w.fmt).toBe(3); expect(w.bits).toBe(32);
    expect(w.sample(1000, 0)).toBeCloseTo(2.7, 5);
  });
  it('quiet signal pcm24 dither error within ±2 LSB', async () => {
    const b = new Builder();
    b.midiTrack('dc', dc(SR * 3, 0.25), [{ tick: 0, dur: 3840 }], { loop: [10, 140000] });
    const { bytes } = await wav(b, { endTick: 960 });
    const w = parseWav(bytes);
    for (let i = 100; i < 2000; i++) expect(Math.abs(w.sample(i, 0) - 0.25 * 8388607)).toBeLessThanOrEqual(2);
  });
});

describe('X03 missing asset/plugin blocks export by default', () => {
  it('blocked, then allowed with fallbacks + diagnostics', async () => {
    const b = new Builder();
    const t = b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    void t;
    b.pcm.clear();
    const blocked = await wav(b);
    expect(!blocked.r.ok && blocked.r.code).toBe('EXPORT_BLOCKED');
    const allowed = await wav(b, { allowFallbacks: true });
    expect(allowed.r.ok && allowed.r.receipt.diagnostics.some((d) => d.startsWith('ASSET_MISSING'))).toBe(true);
  });
  it('unknown plugin → blocked', async () => {
    const b = new Builder();
    b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    const p = structuredClone(b.p); p.plugins[0] = { ...p.plugins[0], pluginId: 'com.example.synth' };
    const chunks: Uint8Array[] = [];
    const r = await renderToWav({ project: p, pcm: b.pcm }, { startTick: 0, endTick: 960, sampleRate: 48000, format: 'wav-pcm24', tailSeconds: 0, seed: 1, allowFallbacks: false }, (c) => { chunks.push(c); });
    expect(!r.ok && r.diagnostics.join()).toMatch(/PLUGIN_MISSING/);
  });
});

describe('X04 long export: bounded memory, cancel, 4GiB pre-reject', () => {
  it('4GiB RIFF limit rejected before rendering', async () => {
    const b = new Builder();
    b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    const t0 = performance.now();
    const r = await wav(b, { format: 'wav-float32', endTick: 960 * 2 * 60 * 60 * 4, sampleRate: 96000 });
    expect(!r.r.ok && r.r.code).toBe('EXPORT_LIMIT');
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('cancel stops rendering', async () => {
    const b = new Builder();
    b.midiTrack('a', impulse(), [{ tick: 0, dur: 10 }]);
    let n = 0;
    const r = await renderToWav({ project: b.p, pcm: b.pcm, isCancelled: () => ++n > 50 }, { startTick: 0, endTick: 960 * 2 * 60, sampleRate: 48000, format: 'wav-pcm24', tailSeconds: 0, seed: 1, allowFallbacks: false }, () => {});
    expect(!r.ok && r.code).toBe('EXPORT_CANCELLED');
  });
  it('5-minute streaming export keeps heap growth bounded (output not retained)', async () => {
    const b = new Builder();
    b.midiTrack('a', dc(SR, 0.2), Array.from({ length: 600 }, (_, i) => ({ tick: i * 960, dur: 480, pitch: 40 + (i % 30) })), { lengthTicks: 960 * 600 });
    (globalThis as { gc?: () => void }).gc?.();
    const h0 = process.memoryUsage().heapUsed; let peak = h0; let bytes = 0;
    const r = await renderToWav({ project: b.p, pcm: b.pcm, onProgress: () => { peak = Math.max(peak, process.memoryUsage().heapUsed); } }, { startTick: 0, endTick: 960 * 600, sampleRate: 48000, format: 'wav-pcm24', tailSeconds: 0, seed: 1, allowFallbacks: false }, (c) => { bytes += c.length; });
    expect(r.ok).toBe(true);
    expect(bytes).toBe(44 + 300 * 48000 * 6);
    const growthMiB = (peak - h0) / 1024 / 1024;
    console.log(`[perf] 5-min export: output ${(bytes / 1e6).toFixed(1)}MB, heap growth ${growthMiB.toFixed(1)}MiB`);
    expect(growthMiB).toBeLessThan(64);
  });
});

describe('X02 MIDI: SMF type1 960PPQ, tempo/meter/CC/bend round trip, losses', () => {
  it('export → independent parse → import round trip', () => {
    const p = structuredClone(f03());
    p.tempoMap = [{ tick: 0, bpm: 120, transition: 'step' }, { tick: 3840, bpm: 90, transition: 'step' }];
    p.meterMap = [{ tick: 0, numerator: 4, denominator: 4 }, { tick: 3840, numerator: 7, denominator: 8 }];
    const { bytes, losses } = exportMidi(p, compileTabSource);
    const smf = parseSmf(bytes);
    expect(smf.format).toBe(1); expect(smf.division).toBe(960);
    const tempos = smf.tracks[0].filter((e) => e.meta === 0x51).map((e) => [e.tick, 60_000_000 / ((e.data[0] << 16) | (e.data[1] << 8) | e.data[2])]);
    expect(tempos.map((t) => t[0])).toEqual([0, 3840]);
    expect(tempos[0][1]).toBe(120); expect(tempos[1][1]).toBeCloseTo(90, 3); // µs/quarter 정수 표현 한계 → tempo-rounding loss
    expect(smf.tracks[0].filter((e) => e.meta === 0x58).map((e) => [e.tick, e.data[0], 2 ** e.data[1]])).toEqual([[0, 4, 4], [3840, 7, 8]]);
    // keys 트랙: CC64 와 pitch bend 보존
    const keys = smf.tracks.find((t) => t.some((e) => e.meta === 3 && new TextDecoder().decode(new Uint8Array(e.data)) === 'Keys'))!;
    expect(keys.filter((e) => (e.status & 0xf0) === 0xb0).map((e) => [e.tick, e.data[0], e.data[1]])).toEqual([[0, 64, 127], [1920, 64, 0]]);
    expect(keys.filter((e) => (e.status & 0xf0) === 0xe0).map((e) => (e.data[1] << 7 | e.data[0]) - 8192)).toEqual([-8192, 8191]);
    expect(keys.filter((e) => (e.status & 0xf0) === 0x90).map((e) => [e.tick, e.status & 15, e.data[0]])).toEqual([[0, 0, 60], [0, 1, 64], [3000, 15, 67]]);
    // drum loop 클립은 전개되어 channel 10
    const drums = smf.tracks.find((t) => t.some((e) => (e.status & 0xf0) === 0x90 && (e.status & 15) === 9));
    expect(drums).toBeTruthy();
    const kinds = losses.map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tab-string-fret', 'tab-technique', 'tab-bend', 'audio-track', 'mixer', 'tempo-rounding']));
    const back = importMidi(bytes);
    expect(back.tempoMap[0].bpm).toBe(120); expect(back.tempoMap[1].bpm).toBeCloseTo(90, 3);
    expect(back.meterMap.map((m) => [m.numerator, m.denominator])).toEqual([[4, 4], [7, 8]]);
    const k2 = back.tracks.find((t) => t.name === 'Keys')!;
    expect(k2.notes.map((n) => [n.tick, n.durationTicks, n.pitch, n.velocity, n.channel])).toEqual([[0, 960, 60, 100, 0], [0, 960, 64, 90, 1], [3000, 840, 67, 1, 15]]);
    expect(k2.pitchBend.map((x) => x.value)).toEqual([-8192, 8191]);
    expect(back.losses).toEqual([]);
  });
  it('import from 480 PPQ reports quantization; program change reported', () => {
    // 수제 SMF: division 480, note at tick 1 (→ 2 at 960), program change
    const trk = [0, 0xc0, 5, 1, 0x90, 60, 100, 1, 0x80, 60, 0, 0, 0xff, 0x2f, 0];
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
    const r = importMidi(bytes);
    expect(r.tracks[0].notes[0]).toMatchObject({ tick: 2, durationTicks: 2 });
    expect(r.losses.map((l) => l.kind)).toEqual(['program-change']);
    const odd = new Uint8Array([...bytes]); odd[13] = 0xdf; // division 479 → 비정수 배율
    expect(importMidi(odd).losses.map((l) => l.kind)).toContain('quantization');
  });
});

describe('WAV decode', () => {
  it('decodes pcm16/24/float32 written by independent writer', () => {
    const mk = (bits: number, fmt: number, vals: number[]) => {
      const bps = bits / 8; const data = new Uint8Array(vals.length * bps); const dv = new DataView(data.buffer);
      vals.forEach((v, i) => { if (fmt === 3) dv.setFloat32(i * 4, v, true); else if (bits === 16) dv.setInt16(i * 2, Math.round(v * 32767), true); else { const q = Math.round(v * 8388607); data[i * 3] = q & 255; data[i * 3 + 1] = (q >> 8) & 255; data[i * 3 + 2] = (q >> 16) & 255; } });
      const h = new DataView(new ArrayBuffer(44)); const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); h.setUint32(4, 36 + data.length, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, fmt, true); h.setUint16(22, 1, true); h.setUint32(24, 44100, true); h.setUint32(28, 44100 * bps, true); h.setUint16(32, bps, true); h.setUint16(34, bits, true); w(36, 'data'); h.setUint32(40, data.length, true);
      const out = new Uint8Array(44 + data.length); out.set(new Uint8Array(h.buffer)); out.set(data, 44); return out;
    };
    for (const [bits, fmt] of [[16, 1], [24, 1], [32, 3]]) {
      const d = decodeWav(mk(bits, fmt, [0, 0.5, -0.5]));
      expect(d.sampleRate).toBe(44100); expect(d.frames).toBe(3);
      expect(d.channels[0][1]).toBeCloseTo(0.5, 3); expect(d.channels[0][2]).toBeCloseTo(-0.5, 3);
    }
  });
});

describe('reverb work spreading is block-size invariant', () => {
  it('identical output for 37/128/512-frame blocks', () => {
    const run = (blk: number) => {
      const ir = [new Float32Array(9000), new Float32Array(9000)];
      for (let i = 0; i < 9000; i++) { ir[0][i] = Math.sin(i * 0.37) * Math.exp(-i / 2000); ir[1][i] = Math.cos(i * 0.21) * Math.exp(-i / 1500); }
      const r = new ReverbDsp(48000, ir, 3);
      const total = 12000; const out = new Float32Array(total);
      for (let pos = 0; pos < total; pos += blk) {
        const n = Math.min(blk, total - pos);
        const io = [new Float32Array(n), new Float32Array(n)];
        for (let i = 0; i < n; i++) { const t = pos + i; io[0][i] = t % 997 === 0 ? 1 : Math.sin(t / 30) * 0.1; io[1][i] = io[0][i]; }
        const params = [new Float32Array(n).fill(0.6), new Float32Array(n).fill(0.8)];
        r.process(io, n, params);
        out.set(io[0], pos);
      }
      return out;
    };
    const a = run(128), b = run(512), c = run(37);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
  });
});
