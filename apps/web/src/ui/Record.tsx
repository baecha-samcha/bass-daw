import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Asset } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';
import { Recorder, type Journal } from '../audio/recorder.ts';
import { importAudioFile } from '../audio/media.ts';
import { useEngineStatus, useMaps } from './hooks.ts';

let shared: { r: Recorder; projectId: string } | null = null;

export function RecordPanel({ tick }: { tick: number }) {
  const { project, store, selection } = useApp();
  const st = useEngineStatus();
  const maps = useMaps(project);
  const rec = useMemo(() => {
    if (!store || !project) return null;
    if (!shared || shared.projectId !== project.id) { shared?.r.disarm(); shared = { r: new Recorder(store, project.id), projectId: project.id }; }
    (globalThis as unknown as { __bassdawRecorder?: Recorder }).__bassdawRecorder = shared.r; // 테스트 장애 주입용
    return shared.r;
  }, [store, project?.id]);
  const ver = useSyncExternalStore((cb) => rec?.subscribe(cb) ?? (() => {}), () => `${rec?.state}|${rec?.recordedFrames}|${rec?.inputPeak.toFixed(2)}|${rec?.error}|${rec?.monitor}|${rec?.devices.length}|${rec?.calibration?.at}|${rec?.calibrationStale}|${rec?.manualOffsetMs}`);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [busy, setBusy] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { void rec?.refreshDevices(); void rec?.pendingJournals().then(setJournals); }, [rec, ver.split('|')[0]]);
  if (!project || !store || !rec || !maps) return <div className="dim">로컬 저장소가 필요합니다.</div>;
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');
  const armedTrack = audioTracks.find((t) => t.id === selection.trackId) ?? audioTracks[0];

  rec.onCommit = (asset: Asset, j: Journal) => {
    const sid = uuid();
    const start = Math.max(0, j.startSeconds - j.offsetFrames / j.sampleRate);
    // 음수 시작은 0 이전 구간을 선택에서 제외(원본 유지)
    const cut = Math.max(0, Math.round((j.offsetFrames / j.sampleRate - j.startSeconds) * j.sampleRate));
    const hasTrack = useApp.getState().project!.tracks.some((t) => t.id === j.trackId);
    return useApp.getState().run('Record take', { type: 'Batch', commands: [
      ...(hasTrack ? [] : [{ type: 'CreateTrack' as const, kind: 'audio' as const, trackId: j.trackId, name: 'Recovered take' }]),
      { type: 'AddAsset', asset },
      { type: 'CreateSource', source: { id: sid, kind: 'audio', assetId: asset.id } },
      { type: 'PlaceClip', trackId: j.trackId, clip: { id: uuid(), kind: 'audio', sourceId: sid, name: `take ${new Date(j.createdAt).toLocaleTimeString()}`, muted: false, startSeconds: start, sourceStartFrame: cut, sourceFrameCount: Math.max(1, asset.audio!.frameCount - cut), gain: 1, fadeInFrames: 0, fadeOutFrames: 0 } },
    ] });
  };

  const importFiles = async (files: FileList) => {
    let trackId = armedTrack?.id;
    if (!trackId) { trackId = uuid(); useApp.getState().run('Add audio track', { type: 'CreateTrack', kind: 'audio', trackId }); }
    for (const f of Array.from(files)) {
      setBusy(`가져오는 중: ${f.name}`);
      try {
        const { asset } = await importAudioFile(store, f, f.name);
        const sid = uuid();
        useApp.getState().run('Import audio', { type: 'Batch', commands: [
          { type: 'AddAsset', asset }, { type: 'CreateSource', source: { id: sid, kind: 'audio', assetId: asset.id } },
          { type: 'PlaceClip', trackId: trackId!, clip: { id: uuid(), kind: 'audio', sourceId: sid, name: f.name.replace(/\.[^.]+$/, ''), muted: false, startSeconds: maps.tm.tickToSeconds(Math.max(0, Math.round(tick))), sourceStartFrame: 0, sourceFrameCount: asset.audio!.frameCount, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 } },
        ] });
      } catch (e) { useApp.getState().toast('error', `가져오기 실패(${f.name}): ${(e as Error).message}`); }
    }
    setBusy('');
  };

  const sr = engine.ctx?.sampleRate ?? 48000;
  return (
    <div className="col">
      <div className="card col">
        <h2>오디오 가져오기</h2>
        <div className="row">
          <button onClick={() => file.current?.click()}>파일 선택 (WAV/MP3/OGG/FLAC…)</button>
          <input ref={file} type="file" accept="audio/*,.wav" multiple hidden onChange={(e) => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }} />
          <span className="dim">대상: {armedTrack?.name ?? '새 오디오 트랙'} · 재생 위치({(maps.tm.tickToSeconds(tick)).toFixed(2)}s)에 배치. 원본 바이트를 SHA-256 으로 보존하며 mono/stereo 만 지원합니다.</span>
        </div>
        {busy && <div className="warn">{busy}</div>}
      </div>
      <div className="card col">
        <h2>마이크 녹음</h2>
        {st.state === 'uninitialized' && <div className="warn">먼저 상단의 “오디오 시작”을 누르세요.</div>}
        <div className="row">
          <label className="row">입력 <select value={rec.deviceId} onChange={(e) => { rec.deviceId = e.target.value; void rec.arm(); }} aria-label="입력 장치">
            <option value="">기본 장치</option>{rec.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </select></label>
          <label className="row">채널 <select value={rec.channels} onChange={(e) => { rec.channels = Number(e.target.value); if (rec.state === 'armed') void rec.arm(); }} aria-label="녹음 채널"><option value={1}>mono</option><option value={2}>stereo</option></select></label>
          <button onClick={() => rec.arm()} disabled={st.state === 'uninitialized' || rec.state === 'recording'}>{rec.state === 'idle' || rec.state === 'error' ? '입력 권한 요청/준비' : '다시 준비'}</button>
          <label className="row"><input type="checkbox" checked={rec.monitor} onChange={(e) => rec.setMonitor(e.target.checked)} /> 모니터링(기본 off — 헤드폰 사용)</label>
          <div className="meter" style={{ width: 120 }} role="meter" aria-label="입력 레벨" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, Math.round(rec.inputPeak * 100) / 100)}><div style={{ width: `${Math.min(100, rec.inputPeak * 100)}%` }} /></div>
        </div>
        <div className="row">
          <span>상태: <b data-testid="rec-state">{rec.state}</b></span>
          <span className="dim">대상 트랙: {armedTrack ? armedTrack.name : '(오디오 트랙을 추가/선택하세요)'}</span>
          {rec.state !== 'recording'
            ? <button className="primary" disabled={!armedTrack || (rec.state !== 'armed' && rec.state !== 'committed')} onClick={() => rec.record(armedTrack!.id)}>● 녹음</button>
            : <button className="primary" onClick={() => rec.stop()}>■ 녹음 정지</button>}
          {rec.state === 'recording' && <span className="mono">{(rec.recordedFrames / sr).toFixed(1)}s · segment {Math.floor(rec.recordedFrames / sr / 5)}</span>}
        </div>
        {rec.error && <div className="err">{rec.error}</div>}
        {rec.settings && <div className="mono dim">실제 settings: {JSON.stringify({ sampleRate: rec.settings.sampleRate, channelCount: rec.settings.channelCount, echoCancellation: rec.settings.echoCancellation, noiseSuppression: rec.settings.noiseSuppression, autoGainControl: rec.settings.autoGainControl, latency: (rec.settings as { latency?: number }).latency })} · context {sr}Hz{rec.settings.sampleRate && rec.settings.sampleRate !== sr ? ' (rate 변환 발생 — journal 에 기록)' : ''}</div>}
        {project.loop.enabled && <div className="warn">녹음 배치는 루프를 전개하지 않습니다(재생 시작 위치 기준 선형 배치).</div>}
      </div>
      <div className="card col">
        <h2>녹음 지연 보정</h2>
        <div className="row">
          <button disabled={rec.state !== 'armed'} onClick={async () => { try { const c = await rec.calibrate(); useApp.getState().toast('info', `round-trip ${(c.roundTripFrames / c.sampleRate * 1000).toFixed(2)}ms (spread ${c.spreadFrames} frames)`); } catch (e) { useApp.getState().toast('error', (e as Error).message); } }}>유선 loopback 10 pulse 측정</button>
          <label className="row">수동 보정(ms) <input type="number" step={0.5} value={rec.manualOffsetMs} onChange={(e) => rec.setManualOffset(Number(e.target.value))} aria-label="수동 보정 ms" /></label>
        </div>
        <div className="mono dim">
          {rec.calibration ? `측정값: ${(rec.calibration.roundTripFrames / rec.calibration.sampleRate * 1000).toFixed(2)}ms (${rec.calibration.roundTripFrames} frames @${rec.calibration.sampleRate}) · ${rec.calibration.at}` : '측정값 없음(보정 0)'}
          {rec.calibrationStale && <span className="err"> · STALE: 장치가 바뀌었습니다. 다시 측정하세요.</span>}
          {' '}· 표시용 추정 baseLatency {engine.ctx?.baseLatency?.toFixed(4) ?? '?'}s / outputLatency {(engine.ctx as AudioContext & { outputLatency?: number } | null)?.outputLatency?.toFixed(4) ?? '?'}s (보정 정답으로 쓰지 않음). Bluetooth 는 보장하지 않습니다.
        </div>
      </div>
      {journals.length > 0 && (
        <div className="card col">
          <h2 className="warn">미완료 녹음</h2>
          {journals.map((j) => (
            <div key={j.id} className="row">
              <span className="mono">{j.createdAt.replace('T', ' ').slice(0, 19)} · {j.state} · 닫힌 segment {j.segments.length}개 ({(j.segments.reduce((s, x) => s + x.frames, 0) / j.sampleRate).toFixed(1)}s){j.reason ? ` · ${j.reason}` : ''}</span>
              <button onClick={async () => { await rec.finalize(j); setJournals(await rec.pendingJournals()); }}>새 오디오 클립으로 복구</button>
              <button onClick={async () => { if (confirm('이 미완료 녹음을 버릴까요?')) { await rec.discard(j); setJournals(await rec.pendingJournals()); } }}>버리기</button>
            </div>
          ))}
          <div className="dim">닫힌(5초 단위) segment 만 복구를 보장합니다. 마지막 미완료 segment 는 복구되지 않을 수 있습니다.</div>
        </div>
      )}
    </div>
  );
}
