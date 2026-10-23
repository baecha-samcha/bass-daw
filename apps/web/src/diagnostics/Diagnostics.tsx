// MVP-0 진단 전용 페이지. 제품 기능과 분리되어 있으며 진단 데이터(diag/*)만 정리한다.
import { useEffect, useRef, useState } from 'react';
import { Sha256, createEmptyProject, sha256HexSync } from '@bass-daw/schemas';
import { OpfsByteStore, IdbByteStore, type ByteStore } from '@bass-daw/storage';
import { encodeWav } from '@bass-daw/audio-engine';
import { ProjectSession } from '@bass-daw/project-core';
import { engine } from '../audio/engine.ts';
import { useEngineStatus } from '../ui/hooks.ts';
import { download } from '../store.ts';

type Row = { key: string; value: string | boolean | number | null; note?: string };

async function detect(): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (key: string, value: Row['value'], note?: string) => rows.push({ key, value, note });
  add('userAgent', navigator.userAgent);
  add('secureContext', globalThis.isSecureContext, 'AudioWorklet/getUserMedia/SW 필요');
  add('crossOriginIsolated', globalThis.crossOriginIsolated ?? false, 'SharedArrayBuffer 조건(COOP/COEP)');
  add('SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined');
  add('AudioContext', typeof AudioContext !== 'undefined');
  add('AudioWorklet', typeof AudioWorkletNode !== 'undefined');
  add('IndexedDB', typeof indexedDB !== 'undefined');
  let opfs = false, writable = false;
  try { const root = await navigator.storage.getDirectory(); opfs = true; const fh = await root.getFileHandle('diag-probe', { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array([1])); await w.close(); writable = true; await root.removeEntry('diag-probe'); } catch { /* */ }
  add('OPFS getDirectory', opfs); add('OPFS createWritable', writable);
  add('OPFS SyncAccessHandle (worker)', await probeSyncHandle());
  add('Web Locks', 'locks' in navigator);
  add('BroadcastChannel', typeof BroadcastChannel !== 'undefined');
  add('getUserMedia', !!navigator.mediaDevices?.getUserMedia);
  add('serviceWorker', 'serviceWorker' in navigator, navigator.serviceWorker?.controller ? 'controlled' : 'not controlling');
  add('download (a[download])', 'download' in document.createElement('a'));
  try { const e = await navigator.storage.estimate(); add('storage quota', `${((e.quota ?? 0) / 2 ** 30).toFixed(2)} GiB`, `usage ${((e.usage ?? 0) / 2 ** 20).toFixed(1)} MiB`); } catch { add('storage quota', null); }
  try { add('storage persisted', await navigator.storage.persisted()); } catch { add('storage persisted', null); }
  add('hardwareConcurrency', navigator.hardwareConcurrency ?? null);
  add('deviceMemory(GiB)', (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null);
  add('performance.memory', !!(performance as Performance & { memory?: unknown }).memory);
  return rows;
}

function probeSyncHandle(): Promise<boolean> {
  return new Promise((res) => {
    try {
      const src = `onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('diag-sync',{create:true});const h=await f.createSyncAccessHandle();h.close();await r.removeEntry('diag-sync');postMessage(true)}catch(e){postMessage(false)}}`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const t = setTimeout(() => { w.terminate(); res(false); }, 3000);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); res(!!e.data); };
      w.onerror = () => { clearTimeout(t); res(false); };
      w.postMessage(0);
    } catch { res(false); }
  });
}

const DIAG_BYTES = 128 * 1024 * 1024;
const LS_KEY = 'bass-daw:diag-storage';

/** 결정적 128MiB 생성기(xorshift) — 1MiB chunk 스트림 */
async function* diagChunks(total = DIAG_BYTES) {
  let x = 20261022 >>> 0;
  for (let off = 0; off < total; off += 1 << 20) {
    const c = new Uint8Array(Math.min(1 << 20, total - off));
    const v = new Uint32Array(c.buffer, 0, c.length >> 2);
    for (let i = 0; i < v.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; v[i] = x; }
    yield c;
  }
}

export function Diagnostics() {
  const [rows, setRows] = useState<Row[]>([]);
  const st = useEngineStatus();
  const [log, setLog] = useState<string[]>([]);
  const [storage, setStorage] = useState<Record<string, unknown>>(() => { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; } });
  const [form, setForm] = useState({ device: '', os: '', browser: '', audioOutput: '', network: '', notes: '' });
  const [mic, setMic] = useState<Record<string, unknown> | null>(null);
  const [freezeRuns, setFreezeRuns] = useState<{ ms: number; before: unknown; after: unknown }[]>([]);
  const micBlob = useRef<Blob | null>(null);
  const L = (s: string) => setLog((l) => [...l.slice(-60), `${new Date().toISOString().slice(11, 23)} ${s}`]);
  useEffect(() => { void detect().then(setRows); }, []);

  const startAudio = async () => {
    const r = await engine.initialize({ requestedSampleRate: 48000, profile: 'balanced' });
    if (!r.ok) return L(`context failed: ${r.errors[0].message}`);
    L(`context started: requested 48000, actual ${engine.ctx!.sampleRate}, state ${engine.ctx!.state}, baseLatency ${engine.ctx!.baseLatency}`);
    // 진단용 impulse/sampler 프로젝트(메모리 전용)
    const pcm = new Float32Array(4800); for (let i = 0; i < 4800; i++) pcm[i] = Math.sin((2 * Math.PI * 880 * i) / 48000) * Math.exp(-i / 600) * 0.5; pcm[0] = 0.9;
    const wav = encodeWav({ sampleRate: 48000, channels: [pcm], frames: pcm.length });
    const hash = sha256HexSync(wav);
    engine.loadAsset = async (h) => (h === hash ? new Blob([wav as unknown as BlobPart]) : null);
    const s = new ProjectSession(createEmptyProject({ title: 'diag' }));
    s.run('t', { type: 'CreateTrack', kind: 'midi', trackId: 'diag-track', name: 'diag' });
    const t = s.project.tracks[0];
    s.run('a', { type: 'AddAsset', asset: { id: 'diag-asset', sha256: hash, byteLength: wav.length, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: pcm.length }, license: { name: 'diag', origin: 'generated', redistribution: 'allowed' } } });
    s.run('s', { type: 'SetPluginState', instanceId: t.instrumentSlot!, state: { version: 1, zones: [{ id: 'z', assetId: 'diag-asset', rootPitch: 69, minPitch: 0, maxPitch: 127, minVelocity: 1, maxVelocity: 127, articulation: 'normal', loopStartFrame: null, loopEndFrame: null }], pads: [], attackMs: 0, releaseMs: 20 }, assets: ['diag-asset'] });
    const len = 960 * 4 * 64;
    s.run('src', { type: 'CreateSource', source: { id: 'diag-src', kind: 'midi', lengthTicks: len, notes: Array.from({ length: 64 * 4 }, (_, i) => ({ id: `d${i}`, tick: i * 960, durationTicks: 240, pitch: i % 4 === 0 ? 81 : 69, velocity: 110, channel: 0 })), cc: [], pitchBend: [] } });
    s.run('clip', { type: 'PlaceClip', trackId: 'diag-track', clip: { id: 'diag-clip', kind: 'music', sourceId: 'diag-src', name: 'diag', muted: false, startTick: 0, durationTicks: len, sourceOffsetTick: 0, loopSource: false } });
    const p = await engine.prepare(s.project);
    L(p.ok ? 'diag sampler prepared (click track every beat, 128s)' : `prepare failed: ${p.errors[0].message}`);
  };

  const injectFreeze = async (ms: number) => {
    const before = { ...st.runtime };
    const t = performance.now(); while (performance.now() - t < ms) { /* 진단 전용 busy wait */ }
    await new Promise((r) => setTimeout(r, 600));
    const after = { ...engine.status.runtime };
    setFreezeRuns((x) => [...x, { ms, before, after }]);
    L(`UI freeze ${ms}ms → late Δ${(after.late ?? 0) - (before.late ?? 0)}, underrun Δ${(after.underruns ?? 0) - (before.underruns ?? 0)}, state ${engine.state}`);
  };

  const storageTest = async (forceIdb: boolean) => {
    let bs: ByteStore | null = forceIdb ? null : await OpfsByteStore.open();
    if (!bs) bs = IdbByteStore.open('bass-daw-diag');
    const t0 = performance.now();
    L(`writing 128MiB to ${bs.kind}…`);
    try {
      const w = await bs.write(`diag/asset-128m`, diagChunks());
      const t1 = performance.now();
      const back = await bs.read('diag/asset-128m');
      const h = new Sha256(); let n = 0;
      for (let o = 0; o < (back?.size ?? 0); o += 1 << 22) { const c = new Uint8Array(await back!.slice(o, o + (1 << 22)).arrayBuffer()); h.update(c); n += c.length; }
      const verify = h.digestHex();
      const res = { backend: bs.kind, bytes: w.bytes, hash: w.hash, verifyHash: verify, verifyBytes: n, writeMs: Math.round(t1 - t0), verifyMs: Math.round(performance.now() - t1), at: new Date().toISOString(), restartCheck: null as null | string };
      localStorage.setItem(LS_KEY, JSON.stringify(res));
      setStorage(res);
      L(`stored ${w.bytes} bytes hash ${w.hash.slice(0, 16)} verify ${verify === w.hash ? 'OK' : 'MISMATCH'}. 이제 브라우저를 완전히 종료 후 다시 열어 “재시작 후 복구 확인”을 누르세요.`);
    } catch (e) { L(`storage test failed: ${(e as DOMException).name}: ${(e as Error).message}`); }
  };

  const restartCheck = async () => {
    const prev = storage as { backend?: string; hash?: string };
    if (!prev.hash) return L('먼저 저장 테스트를 실행하세요.');
    const bs: ByteStore | null = prev.backend === 'opfs' ? await OpfsByteStore.open() : IdbByteStore.open('bass-daw-diag');
    const b = await bs?.read('diag/asset-128m');
    if (!b) { L('RESTORE FAILED: diag asset missing after restart'); setStorage({ ...storage, restartCheck: 'missing' }); return; }
    const h = new Sha256();
    for (let o = 0; o < b.size; o += 1 << 22) h.update(new Uint8Array(await b.slice(o, o + (1 << 22)).arrayBuffer()));
    const ok = h.digestHex() === prev.hash;
    const res = { ...storage, restartCheck: ok ? `OK ${new Date().toISOString()}` : 'HASH MISMATCH' };
    localStorage.setItem(LS_KEY, JSON.stringify(res)); setStorage(res);
    L(`restart check: ${ok ? 'OK — 동일 hash 복구' : 'MISMATCH'}`);
  };

  const clearDiag = async () => {
    for (const bs of [await OpfsByteStore.open(), IdbByteStore.open('bass-daw-diag')]) { if (!bs) continue; for (const p of await bs.list('diag/')) await bs.remove(p); }
    localStorage.removeItem(LS_KEY); setStorage({});
    L('진단 데이터(diag/*)만 삭제했습니다. 프로젝트 데이터는 건드리지 않습니다.');
  };

  const micTest = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return setMic({ error: 'getUserMedia unavailable (insecure context?)' });
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { const n = (e as DOMException).name; return setMic({ error: n === 'NotAllowedError' ? 'PERMISSION_DENIED' : n === 'NotFoundError' ? 'NO_DEVICE' : n, message: (e as Error).message }); }
    const ctx = engine.ctx ?? new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1); // 진단 전용(짧은 dry capture). 제품 녹음은 AudioWorklet 경로.
    const chunks: Float32Array[] = [];
    proc.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(proc).connect(mute).connect(ctx.destination);
    await new Promise((r) => setTimeout(r, 3000));
    src.disconnect(); proc.disconnect(); stream.getTracks().forEach((t) => t.stop());
    const n = chunks.reduce((s, c) => s + c.length, 0); const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    let peak = 0; for (const v of all) peak = Math.max(peak, Math.abs(v));
    micBlob.current = new Blob([encodeWav({ sampleRate: ctx.sampleRate, channels: [all], frames: n }) as unknown as BlobPart], { type: 'audio/wav' });
    setMic({ settings, contextRate: ctx.sampleRate, frames: n, seconds: n / ctx.sampleRate, peak, label: track.label });
  };

  const report = () => ({
    kind: 'bass-daw-mvp0-diagnostics', version: 1, at: new Date().toISOString(), environment: form, features: rows,
    audio: { state: st.state, sampleRate: st.sampleRate, requested: st.requestedSampleRate, baseLatency: st.baseLatency, outputLatency: st.outputLatency, transport: st.transport, runtime: st.runtime, counters: st.counters, diagnostics: st.diagnostics },
    freezeRuns, storage, mic: mic ? { ...mic } : null, log,
  });

  return (
    <div className="page col">
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>환경 진단 (MVP-0)</h1><a href="#/" onClick={() => setTimeout(() => location.reload(), 0)}>앱으로</a></div>
      <div className="card"><h2>1. 기능 탐지</h2>
        <table className="mono" data-testid="features"><tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className={r.value === false ? 'err' : r.value === true ? 'ok' : ''}>{String(r.value)}</td><td className="dim">{r.note}</td></tr>)}</tbody></table>
      </div>
      <div className="card col"><h2>2. 오디오 컨텍스트 · impulse/sampler</h2>
        <div className="row">
          <button className="primary" onClick={startAudio} disabled={st.state !== 'uninitialized' && st.state !== 'error'}>컨텍스트 시작 (48kHz 요청)</button>
          <button onClick={() => engine.play(0)} disabled={st.state === 'uninitialized'}>재생</button>
          <button onClick={() => engine.pause()}>일시정지</button>
          <button onClick={async () => { await engine.ctx?.suspend(); L(`suspend → ${engine.ctx?.state}`); }}>context suspend</button>
          <button onClick={async () => { try { await engine.ctx?.resume(); L(`resume → ${engine.ctx?.state}`); } catch (e) { L(`RESUME FAILED: ${(e as Error).message}`); } }}>context resume</button>
          <button onClick={() => engine.stop()}>정지</button>
        </div>
        <div className="mono">state {st.state} · actual {st.sampleRate || '-'}Hz · ctx {engine.ctx?.state ?? '-'} · transport {st.transport ?? '-'} · late {st.runtime?.late ?? 0} · underrun {st.runtime?.underruns ?? 0}</div>
      </div>
      <div className="card col"><h2>3. 큐 공급 중 UI 정지 주입 (진단 전용)</h2>
        <div className="row"><button onClick={() => injectFreeze(100)} disabled={st.state !== 'playing'}>100ms 정지</button><button onClick={() => injectFreeze(500)} disabled={st.state !== 'playing'}>500ms 정지</button><span className="dim">재생 중에만 가능</span></div>
        {freezeRuns.length > 0 && <pre className="mono">{JSON.stringify(freezeRuns.map((f) => ({ ms: f.ms, lateDelta: ((f.after as { late?: number }).late ?? 0) - ((f.before as { late?: number }).late ?? 0), underrunDelta: ((f.after as { underruns?: number }).underruns ?? 0) - ((f.before as { underruns?: number }).underruns ?? 0) })), null, 1)}</pre>}
      </div>
      <div className="card col"><h2>4. 128MiB 저장 → 재시작 → 복구</h2>
        <div className="row">
          <button onClick={() => storageTest(false)}>저장 테스트 (OPFS, 불가 시 IDB)</button>
          <button onClick={() => storageTest(true)}>IDB Blob fallback 강제</button>
          <button onClick={restartCheck}>재시작 후 복구 확인</button>
          <button onClick={clearDiag}>진단 데이터만 정리</button>
        </div>
        <pre className="mono">{JSON.stringify(storage, null, 1)}</pre>
      </div>
      <div className="card col"><h2>5. 마이크 dry capture (3초) · 다운로드</h2>
        <div className="row"><button onClick={micTest}>권한 요청 후 3초 녹음</button><button disabled={!micBlob.current} onClick={() => micBlob.current && download(micBlob.current, 'diag-capture.wav')}>WAV 다운로드</button></div>
        {mic && <pre className={`mono ${mic.error ? 'err' : ''}`}>{JSON.stringify(mic, null, 1)}</pre>}
      </div>
      <div className="card col"><h2>6. 기기 정보 · 보고서</h2>
        <div className="row">{(Object.keys(form) as (keyof typeof form)[]).map((k) => <label key={k} className="col">{k}<input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}</div>
        <div className="row"><button className="primary" onClick={() => download(new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' }), `bass-daw-diag-${Date.now()}.json`)}>JSON 보고서 다운로드</button></div>
        <pre className="mono" style={{ maxHeight: 200, overflow: 'auto' }}>{log.join('\n')}</pre>
      </div>
    </div>
  );
}
