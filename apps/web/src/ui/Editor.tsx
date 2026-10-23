import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';
import { useEngineStatus, usePlayhead, useMaps, fmtPos } from './hooks.ts';
import { Timeline } from './Timeline.tsx';
import { ClipEditor } from './ClipEditor.tsx';
import { Mixer } from './Mixer.tsx';
import { AutomationPanel } from './Automation.tsx';
import { RecordPanel } from './Record.tsx';
import { ExportPanel } from './Export.tsx';
import { EnginePanel } from './EnginePanel.tsx';
import { PluginsPanel } from './Plugins.tsx';
import { ProjectFilesPanel, projectFileStatus } from './ProjectFiles.tsx';
import { ScorePanel } from './Score.tsx';
import type { Profile } from '@bass-daw/audio-engine';

export function Editor() {
  const { project, saveStatus, saveError, readOnly, panel, session, fileBusy } = useApp();
  const st = useEngineStatus();
  const maps = useMaps(project);
  const tick = usePlayhead();
  const [profile, setProfile] = useState<Profile>('balanced');
  const prepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 프로젝트 변경 → 엔진 plan 갱신(변경 source 만 재컴파일, 재생 중이면 표 교체)
  useEffect(() => {
    if (!project || st.state === 'uninitialized' || st.state === 'error' || st.state === 'closed') return;
    if (prepTimer.current) clearTimeout(prepTimer.current);
    prepTimer.current = setTimeout(() => { void engine.prepare(project); }, 40);
  }, [project, st.state === 'uninitialized']);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (e.target as HTMLElement).blur?.(); void useApp.getState().saveProjectFile({saveAs:e.shiftKey}); return; }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); void togglePlay(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) useApp.getState().redo(); else useApp.getState().undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); useApp.getState().redo(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (!project || !maps) return null;
  const togglePlay = async () => {
    if (engine.state === 'uninitialized') return startAudio();
    if (engine.state === 'playing') await engine.pause(); else await engine.play();
  };
  const startAudio = async () => {
    const r = await engine.initialize({ requestedSampleRate: 48000, profile });
    if (!r.ok) return useApp.getState().toast('error', `오디오 시작 실패: ${r.errors[0].message}`);
    await engine.prepare(useApp.getState().project!);
  };
  const bpm = project.tempoMap[0].bpm;
  const setBpm = (v: number) => { if (v >= 20 && v <= 400) useApp.getState().run('Tempo', { type: 'SetTempoMap', tempoMap: [{ ...project.tempoMap[0], bpm: v }, ...project.tempoMap.slice(1)] }); };
  const meter = project.meterMap[0];
  const loopBars = [maps.mm.tickToBarBeat(project.loop.startTick).bar, maps.mm.tickToBarBeat(project.loop.endTick).bar];

  return (
    <div className="editor">
      <div className="topbar" role="toolbar" aria-label="프로젝트 도구">
        <button onClick={async () => { await useApp.getState().closeProject(); useApp.getState().set({ view: 'home' }); await useApp.getState().refreshProjects(); }} aria-label="프로젝트 목록">◀</button>
        <input className="title" aria-label="프로젝트 제목" defaultValue={project.title} key={project.title} onBlur={(e) => { if (e.target.value !== project.title) useApp.getState().run('Rename project', { type: 'SetTitle', title: e.target.value.slice(0, 256) }); }} />
        <span className="dim">복구본</span><span className={`status-pill ${saveStatus}`} title={saveError ?? ''} aria-live="polite" data-testid="save-status">{saveLabel(saveStatus)}</span>
        <span className="status-pill" data-testid="file-status" aria-live="polite">{projectFileStatus(useApp.getState())}</span>
        <button onClick={() => useApp.getState().undo()} disabled={!session?.canUndo || !!readOnly} title={`Undo ${session?.undoLabel ?? ''}`} aria-label="실행 취소">↶</button>
        <button onClick={() => useApp.getState().redo()} disabled={!session?.canRedo || !!readOnly} title={`Redo ${session?.redoLabel ?? ''}`} aria-label="다시 실행">↷</button>
        <span className="dim" style={{ borderLeft: '1px solid var(--line)', height: 24 }} />
        {st.state === 'uninitialized' || st.state === 'error' ? (
          <>
            <select aria-label="성능 프로필" value={profile} onChange={(e) => setProfile(e.target.value as Profile)}><option value="high">high</option><option value="balanced">balanced</option><option value="low">low</option></select>
            <button className="primary" onClick={startAudio}>🔊 오디오 시작</button>
          </>
        ) : (
          <>
            <button className={st.state === 'playing' ? 'on' : ''} onClick={togglePlay} aria-label={st.state === 'playing' ? '일시정지' : '재생'}>{st.state === 'playing' ? '❚❚' : '▶'}</button>
            <button onClick={() => engine.stop()} aria-label="정지">■</button>
          </>
        )}
        <span className="mono" aria-label="재생 위치" data-testid="position">{fmtPos(maps.mm, tick)}</span>
        <label className="row">BPM <input type="number" min={20} max={400} step={1} aria-label="템포" defaultValue={bpm} key={bpm} onBlur={(e) => setBpm(Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') setBpm(Number((e.target as HTMLInputElement).value)); }} /></label>
        <span className="mono dim">{meter.numerator}/{meter.denominator}</span>
        <button className={project.loop.enabled ? 'on' : ''} onClick={() => useApp.getState().run('Loop', { type: 'SetLoop', ...project.loop, enabled: !project.loop.enabled })} aria-pressed={project.loop.enabled}>⟲ 루프</button>
        <label className="row dim">마디 <input type="number" min={1} aria-label="루프 시작 마디" defaultValue={loopBars[0]} key={`ls${loopBars[0]}`} onBlur={(e) => { const s = maps.mm.barToTick(Math.max(1, Number(e.target.value))); if (s < project.loop.endTick) useApp.getState().run('Loop', { type: 'SetLoop', ...project.loop, startTick: s }); }} />–<input type="number" min={2} aria-label="루프 끝 마디" defaultValue={loopBars[1]} key={`le${loopBars[1]}`} onBlur={(e) => { const s = maps.mm.barToTick(Math.max(2, Number(e.target.value))); if (s > project.loop.startTick) useApp.getState().run('Loop', { type: 'SetLoop', ...project.loop, endTick: s }); }} /></label>
        <button onClick={() => useApp.getState().saveNow()} aria-label="복구본 저장">복구본 저장</button>
        <button className="primary" disabled={fileBusy} onClick={() => void useApp.getState().saveProjectFile()}>파일 저장 (.dawbae)</button>
        <button disabled={fileBusy} onClick={() => void useApp.getState().saveProjectFile({saveAs:true})}>다른 이름으로 저장</button>
        {readOnly && <button className="primary" onClick={() => useApp.getState().openProject(project.id, { takeover: true })}>이 탭에서 편집(가져오기)</button>}
      </div>
      <div className="main">
        <Timeline tick={tick} />
        <div className="panel">
          <div className="tabs" role="tablist">
            {([['editor', '편집'], ['mixer', '믹서'], ['automation', '자동화'], ['record', '녹음/가져오기'], ['export', '내보내기'], ['score', '악보'], ['plugins', '플러그인'], ['files', '프로젝트 파일'], ['engine', '엔진 진단']] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={panel === k} className={panel === k ? 'on' : ''} onClick={() => useApp.getState().set({ panel: k })}>{l}</button>
            ))}
          </div>
          <div className="panel-body">
            {panel === 'editor' && <ClipEditor tick={tick} />}
            {panel === 'mixer' && <Mixer />}
            {panel === 'automation' && <AutomationPanel />}
            {panel === 'record' && <RecordPanel tick={tick} />}
            {panel === 'export' && <ExportPanel />}
            {panel === 'engine' && <EnginePanel />}
            {panel === 'plugins' && <PluginsPanel />}
            {panel === 'files' && <ProjectFilesPanel />}
            {panel === 'score' && <ScorePanel />}
          </div>
        </div>
      </div>
      <div className="bottombar">
        <span>엔진: {st.state}{st.sampleRate ? ` · ${st.sampleRate}Hz (요청 48000)` : ''}{st.transport ? ` · ${st.transport}` : ''}</span>
        {st.counters && <span>late {st.runtime?.late ?? 0} · underrun {st.runtime?.underruns ?? 0} · voices {st.activeVoices} · steal {st.counters.voiceSteals}</span>}
        {readOnly && <span className="err">{readOnly}</span>}
        {saveError && <span className="err">{saveError}</span>}
        <span><span className="kbd">Space</span> 재생 <span className="kbd">Ctrl+Z</span> 취소 <span className="kbd">Ctrl+S</span> 저장</span>
      </div>
    </div>
  );
}

function saveLabel(s: string) {
  return ({ clean: '저장됨', saved: '저장됨', dirty: '미저장', saving: '저장 중…', degraded: '저장 문제(degraded)', 'quota-error': '저장 실패: 용량', 'read-only': '읽기 전용' } as Record<string, string>)[s] ?? s;
}
