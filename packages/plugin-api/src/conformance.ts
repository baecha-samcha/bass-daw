// 설치 전 시험 렌더/적합성(P01). Worker 또는 별도 프로세스에서 watchdog 과 함께 실행한다 —
// 무한 루프는 같은 스레드 안에서 중단할 수 없으므로 이 검사는 실시간 격리 보장이 아니다.
import type { PluginManifest } from '@bass-daw/schemas';
import { WasmPluginRuntime, type PluginEvent } from './runtime.ts';

export interface ConformanceReport { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[]; renderMsPerSecond: number }

export function runConformance(module: WebAssembly.Module, manifest: PluginManifest, memoryPages: number, sampleRate = 48000): ConformanceReport {
  const checks: ConformanceReport['checks'] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const params = (n: number) => manifest.parameters.map((d) => new Float32Array(n).fill(d.default));
  const testSample = { channels: [Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * Math.exp(-i / 2000))], sampleRate };
  const make = () => { const r = new WasmPluginRuntime(module, manifest, sampleRate, memoryPages); r.prepare('{}', manifest.role === 'instrument' ? [testSample] : []); return r; };
  let rt: WasmPluginRuntime;
  try { rt = make(); check('prepare', true); }
  catch (e) { check('prepare', false, (e as Error).message); return { ok: false, checks, renderMsPerSecond: NaN }; }
  // 1) impulse 응답과 latency 일치(effect), 출력 finite·frame 수
  const len = 8192;
  const render = (blocks: number[]): Float32Array[] | null => {
    const r = make();
    const out = [new Float32Array(len), new Float32Array(len)];
    if (manifest.role === 'effect') out[0][0] = 1, out[1][0] = 1;
    const ev: PluginEvent[] = manifest.role === 'instrument' ? [{ offset: 0, type: 1, voice: 1, channel: 0, d0: 60, d1: 1, d2: 0 }] : [];
    let pos = 0, k = 0;
    while (pos < len) {
      const n = Math.min(blocks[k++ % blocks.length], len - pos);
      const ok = r.process(out, n, pos === 0 ? ev : [], pos === 0 ? ev.length : 0, params(n), pos);
      if (!ok) { check(`process blocks ${blocks.join('/')}`, false, r.faulted ?? 'fault'); return null; }
      pos += n;
    }
    return out;
  };
  const a = render([128]); const b = render([37, 512, 1000, 64]);
  check('finite output, exact frames (block 128)', !!a);
  check('finite output, exact frames (block 37/512/1000/64)', !!b);
  if (a && b) {
    let same = true; for (let i = 0; i < len; i++) if (a[0][i] !== b[0][i] || a[1][i] !== b[1][i]) { same = false; break; }
    check('block-size invariant output', same);
    if (manifest.role === 'effect') {
      let first = -1; for (let i = 0; i < len; i++) if (Math.abs(a[0][i]) > 1e-6) { first = i; break; }
      check('impulse latency matches descriptor', first === -1 || first === manifest.latencyFrames, `first nonzero ${first}, latencyFrames ${manifest.latencyFrames}`);
      if (manifest.tailFrames !== null && manifest.latencyFrames + manifest.tailFrames + 1 < len) {
        let tail = 0; for (let i = manifest.latencyFrames + manifest.tailFrames + 1; i < len; i++) tail = Math.max(tail, Math.abs(a[0][i]));
        check('tail ends within tailFrames', tail < 1e-4, `max after tail ${tail}`);
      }
    } else {
      let e = 0; for (let i = 0; i < len; i++) e += Math.abs(a[0][i]);
      check('instrument produces sound for noteOn', e > 0);
    }
  }
  // 2) 처리 시간(참고)
  const t0 = performance.now(); const r = make(); const io = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < 375; i++) r.process(io, 128, [], 0, params(128));
  const renderMsPerSecond = performance.now() - t0;
  return { ok: checks.every((c) => c.ok), checks, renderMsPerSecond };
}
