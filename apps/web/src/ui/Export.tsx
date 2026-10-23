import { useRef, useState } from 'react';
import type { ExportOptions, RenderReceipt } from '@bass-daw/audio-engine';
import { exportMidi, type Loss } from '@bass-daw/midi-engine';
import { compileTabSource } from '@bass-daw/tab-engine';
import { TempoMap } from '@bass-daw/music-core';
import { paths } from '@bass-daw/storage';
import { useApp, download, safe } from '../store.ts';
import { getPcm } from '../audio/pcm-cache.ts';
import { engine } from '../audio/engine.ts';
import { songEndTick } from './hooks.ts';

export function ExportPanel() {
  const { project, store } = useApp();
  const [opts, setOpts] = useState({ range: 'song' as 'song' | 'loop', format: 'wav-pcm24' as ExportOptions['format'], sampleRate: 48000 as ExportOptions['sampleRate'], tail: 2, allowFallbacks: false });
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ receipt?: RenderReceipt; error?: string; diagnostics?: string[]; ms?: number } | null>(null);
  const [losses, setLosses] = useState<Loss[] | null>(null);
  const worker = useRef<Worker | null>(null);
  if (!project) return null;
  const tm = new TempoMap(project.tempoMap);
  const songEnd = songEndTick(project, tm);

  const runWav = async () => {
    setResult(null); setProgress(0);
    const sr = opts.sampleRate;
    const pcm: [string, Float32Array[], number][] = [];
    const missing: string[] = [];
    for (const a of project.assets) {
      if (!a.audio) continue;
      try { const p = await getPcm(a.sha256, sr, (h) => store ? store.readAsset(h) : Promise.resolve(null), a.mediaType); if (p) pcm.push([a.sha256, p.channels, p.sampleRate]); else missing.push(a.sha256); } catch { missing.push(a.sha256); }
    }
    const options: ExportOptions = { startTick: opts.range === 'loop' ? project.loop.startTick : 0, endTick: opts.range === 'loop' ? project.loop.endTick : songEnd, sampleRate: sr, format: opts.format, tailSeconds: opts.tail, seed: 20261022, allowFallbacks: opts.allowFallbacks };
    worker.current?.terminate();
    const w = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = async (e) => {
      if (e.data.type === 'progress') setProgress(e.data.done / e.data.total);
      if (e.data.type === 'done') {
        setProgress(null); w.terminate(); worker.current = null;
        if (!e.data.ok) return setResult({ error: `${e.data.code}: ${e.data.message}`, diagnostics: e.data.diagnostics });
        let blob: Blob | null = e.data.blob;
        if (!blob && e.data.path && store) blob = await store.bytes.read(e.data.path);
        if (blob) download(blob, `${safe(project.title)}.wav`);
        setResult({ receipt: e.data.receipt, ms: e.data.ms });
        if (e.data.path && store) setTimeout(() => void store.bytes.remove(e.data.path), 60_000);
      }
    };
    const ext = await engine.resolvePlugins(project);
    w.postMessage({ type: 'render', project, options, pcm, profile: 'high', plugins: [...ext.values()].map((x) => [x.key, { key: x.key, manifest: x.manifest, memoryPages: x.memoryPages }]), wasm: [...ext.values()].map((x) => [x.key, x.dsp]), pluginHashes: [...ext.values()].map((x) => `${x.key}#${x.bundleHash}`) });
  };

  const runMidi = () => {
    const r = exportMidi(project, compileTabSource);
    setLosses(r.losses);
    download(new Blob([r.bytes as unknown as BlobPart], { type: 'audio/midi' }), `${safe(project.title)}.mid`);
  };

  return (
    <div className="col">
      <div className="card col">
        <h2>WAV 내보내기</h2>
        <div className="row">
          <label className="row">범위 <select value={opts.range} onChange={(e) => setOpts({ ...opts, range: e.target.value as 'song' | 'loop' })}><option value="song">곡 전체</option><option value="loop">루프 구간</option></select></label>
          <label className="row">포맷 <select value={opts.format} onChange={(e) => setOpts({ ...opts, format: e.target.value as ExportOptions['format'] })}><option value="wav-pcm24">PCM 24-bit (TPDF dither, clamp)</option><option value="wav-float32">Float 32 (no clipping)</option></select></label>
          <label className="row">Rate <select value={opts.sampleRate} onChange={(e) => setOpts({ ...opts, sampleRate: Number(e.target.value) as ExportOptions['sampleRate'] })}><option value={44100}>44100</option><option value={48000}>48000</option><option value={96000}>96000</option></select></label>
          <label className="row">Tail(초) <input type="number" min={0} max={10} step={0.5} value={opts.tail} onChange={(e) => setOpts({ ...opts, tail: Number(e.target.value) })} /></label>
          <label className="row"><input type="checkbox" checked={opts.allowFallbacks} onChange={(e) => setOpts({ ...opts, allowFallbacks: e.target.checked })} /> 누락 자산/플러그인을 무음·bypass 로 허용</label>
        </div>
        <div className="row">
          <button className="primary" onClick={runWav} disabled={progress !== null}>WAV 렌더</button>
          {progress !== null && <><progress value={progress} max={1} /> <button onClick={() => worker.current?.postMessage({ type: 'cancel' })}>취소</button></>}
        </div>
        {result?.error && <div className="err">{result.error}{result.diagnostics?.length ? <ul>{result.diagnostics.map((d) => <li key={d}>{d}</li>)}</ul> : null}</div>}
        {result?.receipt && <div className="mono">frames {result.receipt.frames} · peak {result.receipt.peak.toFixed(3)} · sha256 {result.receipt.outputAssetHash.slice(0, 16)}… · {result.ms?.toFixed(0)}ms · {result.receipt.engineVersion}{result.receipt.diagnostics.length ? <ul>{result.receipt.diagnostics.map((d) => <li key={d}>{d}</li>)}</ul> : null}</div>}
        <div className="dim">worker 에서 block 단위로 렌더해 파일로 스트리밍합니다(전체 PCM 을 메모리에 올리지 않음). 자동 normalization 은 하지 않습니다. 4GiB(RIFF) 초과는 렌더 전에 거절합니다.</div>
      </div>
      <div className="card col">
        <h2>MIDI 내보내기 (SMF type 1, 960 PPQ)</h2>
        <div className="row"><button onClick={runMidi}>.mid 내보내기</button></div>
        {losses && (losses.length ? <div><b className="warn">손실 목록</b><ul>{losses.map((l, i) => <li key={i}>{l.message}</li>)}</ul></div> : <div className="ok">손실 없음</div>)}
      </div>
      <div className="card col">
        <h2>로컬 프로젝트 파일</h2>
        <div className="row"><button onClick={() => useApp.getState().exportBackup()}>.dawbae 파일 내려받기</button><span className="dim">프로젝트·원본 음원·녹음 포함. 다른 기기에서 파일을 열어 편집합니다. 다운로드 완료 여부는 브라우저에서 확인하세요.</span></div>
      </div>
      <span className="mono dim" hidden>{paths.export('x')}</span>
    </div>
  );
}
