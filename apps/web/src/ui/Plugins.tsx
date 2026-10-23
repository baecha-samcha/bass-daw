import { useEffect, useRef, useState } from 'react';
import type { PluginManifest } from '@bass-daw/schemas';
import { useApp } from '../store.ts';

interface Pending { manifest: PluginManifest & { bundleHash: string }; bytes: Uint8Array; expected?: string }

export function PluginsPanel() {
  const { pluginHost, installedPlugins } = useApp();
  const [samples, setSamples] = useState<{ file: string; pluginId: string; version: string; name: string; role: string; bundleSha256: string }[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { fetch('./plugins/index.json').then((r) => r.json()).then(setSamples).catch(() => setSamples([])); }, []);
  if (!pluginHost) return <div className="dim">로컬 저장소가 필요합니다.</div>;
  const inspect = async (bytes: Uint8Array, expected?: string) => {
    const r = await pluginHost.inspect(bytes);
    if (!r.ok) return useApp.getState().toast('error', `검사 거절 — ${r.errors.map((e) => e.message).join('; ')}`);
    setPending({ manifest: r.value, bytes, expected });
  };
  const install = async () => {
    if (!pending) return;
    setBusy('시험 렌더 중(최대 5초 watchdog)…');
    const r = await pluginHost.install(pending.manifest, pending.manifest.bundleHash, pending.bytes);
    setBusy('');
    if (!r.ok) return useApp.getState().toast('error', `설치 실패 — ${r.errors[0].code}: ${r.errors[0].message}`);
    useApp.getState().toast('info', `설치됨: ${r.value}`);
    setPending(null);
    await useApp.getState().refreshPlugins();
  };
  const m = pending?.manifest;
  const reviewedOk = !!m && pluginHost.reviewed({ manifest: m, bundleHash: m.bundleHash });
  return (
    <div className="col">
      <div className="card col">
        <h2>설치된 플러그인</h2>
        {installedPlugins.length === 0 && <div className="dim">없음. 내장 EQ/Compressor/Reverb/Sampler 는 설치 없이 사용합니다.</div>}
        <table><tbody>{installedPlugins.map((p) => (
          <tr key={p.key} data-testid={`installed-${p.manifest.pluginId}`}>
            <td><b>{p.manifest.name}</b> <span className="mono dim">{p.key} · {p.manifest.role}</span>{!pluginHost.reviewed(p) && <span className="err" data-testid="not-reviewed"> 검토 목록에 없음 — 실행 차단</span>}<div className="mono dim">bundle sha256 {p.bundleHash.slice(0, 16)}… · latency {p.manifest.latencyFrames} · tail {p.manifest.tailFrames ?? '∞'} · mem {p.memoryPages} pages · 권한 [{p.manifest.permissions.join(', ') || '없음'}]</div></td>
            <td><button className="small" onClick={async () => { if (confirm(`${p.key} 를 제거할까요? 이 플러그인을 쓰는 프로젝트는 상태를 보존한 채 "missing" 으로 표시됩니다.`)) { await pluginHost.uninstall(p.key); await useApp.getState().refreshPlugins(); } }}>제거</button></td>
          </tr>))}</tbody></table>
      </div>
      <div className="card col">
        <h2>설치</h2>
        <div className="row">
          {samples.map((s) => <button key={s.file} onClick={async () => inspect(new Uint8Array(await (await fetch(`./plugins/${s.file}`)).arrayBuffer()), s.bundleSha256)}>샘플 검사: {s.name}</button>)}
          <button onClick={() => file.current?.click()}>파일에서 검사 (.bdplugin)</button>
          <input ref={file} type="file" accept=".bdplugin,.zip" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await inspect(new Uint8Array(await f.arrayBuffer())); e.target.value = ''; }} />
        </div>
        {m && (
          <div className="card col" role="group" aria-label="설치 승인">
            <b>{m.name} <span className="mono">{m.pluginId}@{m.version}</span> ({m.role}) — {m.vendor}, {m.license}</b>
            <div className="mono">bundle sha256 <span data-testid="bundle-hash">{m.bundleHash}</span>{pending!.expected && (pending!.expected === m.bundleHash ? <span className="ok"> ✓ 목록 hash 일치</span> : <span className="err"> ✗ 목록 hash 불일치</span>)}</div>
            <div data-testid="review-state">{reviewedOk ? <span className="ok">✓ 검토된 고정 hash</span> : <span className="err">✗ 검토 목록에 없는 hash — 설치할 수 없습니다(외부 DSP 는 검토된 고정 hash 만 허용, 공개 업로드·마켓 없음)</span>}</div>
            <div className="mono dim">dsp {m.dsp.sha256.slice(0, 16)}… · ABI {m.dsp.abi} · UI {m.ui ? 'sandbox iframe' : '없음(host UI)'} · 채널 {m.channels.inputs}→{m.channels.outputs} · latency {m.latencyFrames} · 파라미터 {m.parameters.map((p) => p.id).join(', ')}</div>
            <div>요청 권한: {m.permissions.length ? m.permissions.join(', ') : '없음'} · 네트워크/파일시스템/임의 JS DSP 는 허용하지 않습니다.</div>
            <div className="warn">외부 DSP 는 오디오 스레드에서 실행되며 무한 루프·과도한 CPU 는 격리되지 않습니다. 그래서 검토된 고정 hash 만 설치·실행합니다.</div>
            <div className="row"><button className="primary" onClick={install} disabled={!!busy || !reviewedOk}>이 hash 를 승인하고 설치</button><button onClick={() => setPending(null)}>취소</button>{busy && <span className="warn">{busy}</span>}</div>
          </div>
        )}
      </div>
    </div>
  );
}
