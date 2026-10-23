import { useState } from 'react';
import type { Asset } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import { synthKit, KIT_LICENSE, type KitName } from '@bass-daw/audio-engine';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';
import { useEngineStatus } from './hooks.ts';
import { buildF02, f02AudioWav } from '../fixtures/f02.ts';

/** 진단 전용: main thread 를 의도적으로 멈춘다(제품 기능 아님). */
function freeze(ms: number) { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } }

export async function loadF02(variant: 'M2' | 'full', minutes: number, m5Load: boolean) {
  const { store } = useApp.getState();
  if (!store) throw new Error('storage required');
  const kits = {} as Record<KitName, Asset[]>;
  for (const k of ['bass', 'guitar', 'keys', 'drums'] as KitName[]) {
    kits[k] = [];
    for (const s of synthKit(k)) {
      const r = await store.importAsset(s.bytes);
      if (!r.ok) throw new Error(r.errors[0].message);
      kits[k].push({ id: uuid(), sha256: r.value.hash, byteLength: r.value.bytes, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: (s.bytes.length - 44) / 2 }, license: { ...KIT_LICENSE } });
    }
  }
  const audio: Asset[] = [];
  if (variant === 'full') for (let i = 0; i < 4; i++) {
    const bytes = f02AudioWav(20261022 + i);
    const r = await store.importAsset(bytes);
    if (!r.ok) throw new Error(r.errors[0].message);
    audio.push({ id: uuid(), sha256: r.value.hash, byteLength: r.value.bytes, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: 48000 * 60 }, license: { name: 'F02 synthetic audio', origin: 'bass-daw fixture seed 20261022', redistribution: 'allowed' } });
  }
  const p = buildF02(kits, audio, { variant, minutes, m5Load });
  const lease = await store.acquireLease(p.id);
  if (!lease.ok) throw new Error(lease.errors[0].message);
  const c = await store.commit(p, null, 0);
  if (!c.ok) throw new Error(`${c.errors[0].code}: ${c.errors[0].message}`);
  await store.releaseLease(p.id);
  await useApp.getState().openProject(p.id);
}

export function EnginePanel() {
  const st = useEngineStatus();
  const [stats, setStats] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [min, setMin] = useState(30);
  const c = st.counters;
  const rt = st.runtime;
  return (
    <div className="col">
      <div className="card col">
        <h2>엔진 상태</h2>
        <table className="mono"><tbody>
          <tr><td>state</td><td data-testid="engine-state">{st.state}</td><td>sampleRate</td><td>{st.sampleRate} (요청 {st.requestedSampleRate})</td></tr>
          <tr><td>transport</td><td>{st.transport ?? '-'} (SAB ring / MessagePort)</td><td>profile</td><td>{st.profile}</td></tr>
          <tr><td>baseLatency</td><td>{st.baseLatency?.toFixed(4) ?? '-'}s</td><td>outputLatency</td><td>{st.outputLatency?.toFixed(4) ?? '-'}s</td></tr>
          <tr><td>graph PDC latency</td><td>{st.graphLatency} frames</td><td>decoded PCM</td><td>{(st.pcmBytes / 2 ** 20).toFixed(1)} MiB</td></tr>
          <tr><td>late / stale</td><td data-testid="late">{rt?.late ?? 0} / {rt?.stale ?? 0}</td><td>underrun / low-water</td><td data-testid="underruns">{rt?.underruns ?? 0} / {rt?.lowWater ?? 0}</td></tr>
          <tr><td>active voices</td><td>{st.activeVoices}</td><td>voice steals</td><td>{c?.voiceSteals ?? 0}</td></tr>
          <tr><td>DSP faults</td><td>{c?.faults ?? 0}</td><td>articulation fallback</td><td>{c?.articulationFallbacks ?? 0}</td></tr>
          <tr><td>plugin faults</td><td data-testid="plugin-faults">{st.pluginFaults.map((f) => `${f.instanceId.slice(0, 8)}:${f.reason}`).join(', ') || 0}</td><td>diagnostics</td><td>{st.diagnostics.slice(-1)[0] ?? ''}</td></tr>
          <tr><td>WASM 컴파일(준비 단계)</td><td data-testid="wasm-compiles" data-json={JSON.stringify(st.wasmCompiles)}>{st.wasmCompiles.map((w) => `${w.key}:${w.transport}${w.ok ? '' : `✗${w.reason ?? ''}`}`).join(', ') || '-'}</td><td></td><td></td></tr>
          <tr><td>missing samples</td><td>{c?.missingSamples ?? 0}</td><td>master clip(&gt;1.0)</td><td>{c?.clippedPeaks ?? 0}</td></tr>
          <tr><td>block time max (diag)</td><td>{st.blockMsMax.toFixed(2)} ms (Date.now 해상도, 추정치)</td><td>queue fedUntil</td><td>{rt?.fedUntil ?? 0}</td></tr>
        </tbody></table>
        <div className="row">
          <button onClick={async () => setStats(JSON.stringify(await engine.schedulerStats()))}>scheduler 통계</button>
          <button onClick={() => engine.panic()}>panic</button>
          <button onClick={() => engine.injectProcessorError()} title="진단 전용: AudioWorkletProcessor 예외 → processorerror → node 재생성">processorerror 주입</button>
          <span className="mono dim">{stats}</span>
        </div>
        <div className="dim">내부 카운터는 실제 DAC 출력 결함을 관측하지 못합니다. “끊김 0” 판정에는 외부 loopback 녹음이 필요합니다(05 §5).</div>
      </div>
      <div className="card col">
        <h2>진단 전용: UI 정지 주입</h2>
        <div className="row">
          <button onClick={() => freeze(100)}>main thread 100ms 정지</button>
          <button onClick={() => freeze(500)}>main thread 500ms 정지</button>
          <button onClick={() => freeze(2000)}>2000ms 정지</button>
          <span className="dim">재생 중 눌러 late/underrun 변화를 관찰합니다. 큐 공급은 worker 에서 하므로 main 정지만으로는 끊기지 않아야 합니다.</span>
        </div>
      </div>
      <div className="card col">
        <h2>부하 fixture (F02)</h2>
        <div className="row">
          <label className="row">길이(분) <input type="number" min={1} max={30} value={min} onChange={(e) => setMin(Number(e.target.value))} /></label>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await loadF02('M2', min, false); } catch (e) { useApp.getState().toast('error', (e as Error).message); } setBusy(false); }}>F02-M2 열기 (sampler 16트랙)</button>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await loadF02('full', min, false); } catch (e) { useApp.getState().toast('error', (e as Error).message); } setBusy(false); }}>F02 (audio 4 포함)</button>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await loadF02('full', min, true); } catch (e) { useApp.getState().toast('error', (e as Error).message); } setBusy(false); }}>F02 + M5 부하</button>
        </div>
        <div className="dim">자체 합성 신호만 사용(seed 20261022). 30분×3회 실제 Chromebook 측정은 docs/reports 의 절차를 따르세요.</div>
      </div>
    </div>
  );
}
