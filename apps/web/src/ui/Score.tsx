// 베이스 악보 출력 UI: 검증 화면(#/score-check), 편집기 '악보' 패널, 인쇄 미리보기(오버레이 → window.print = 브라우저 PDF 저장).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildDrumNotation, DRUM_INSTRUMENTS, drumPadKey, suggestDrumInstrument, type DrumScore, type DrumMappings, type DrumInstrument, buildBassNotation, type NotationScore, type NotationDiagnostic, type StaveChoice, type KeySignatureChoice } from '@bass-daw/notation';
import { MeterMap } from '@bass-daw/music-core';
import type { Project } from '@bass-daw/schemas';
import { renderNotation } from '../score/render.ts';
import { drumCheckCases } from '../score/drum-check-cases.ts';
import { checkCases } from '../score/check-cases.ts';
import { useApp } from '../store.ts';

const KEYS: { label: string; fifths: number }[] = [
  ['C♭', -7], ['G♭', -6], ['D♭', -5], ['A♭', -4], ['E♭', -3], ['B♭', -2], ['F', -1], ['C', 0], ['G', 1], ['D', 2], ['A', 3], ['E', 4], ['B', 5], ['F♯', 6], ['C♯', 7],
].map(([label, fifths]) => ({ label: label as string, fifths: fifths as number }));
const sig = (f: number) => (f > 0 ? `♯${f}` : f < 0 ? `♭${-f}` : '조표 없음');
const MINOR = ['a♭', 'e♭', 'b♭', 'f', 'c', 'g', 'd', 'a', 'e', 'b', 'f♯', 'c♯', 'g♯', 'd♯', 'a♯'];

/** NotationScore 한 장을 alphaTab 으로 그린다(흰 바탕·검은 잉크, 인쇄와 같은 폭) */
export function ScoreSheet({ score, testId, onReady }: { score: NotationScore | DrumScore; testId: string; onReady?: (ready: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'rendering' | 'done' | string>('rendering');
  useEffect(() => {
    let r: { destroy(): void } | null = null; let alive = true;
    setState('rendering'); onReady?.(false);
    renderNotation(el.current!, score).then((x) => { r = x; if (alive) { setState('done'); onReady?.(true); } else x.destroy(); }, (e) => alive && setState(`error: ${(e as Error).message}`));
    return () => { alive = false; r?.destroy(); };
  }, [score, onReady]);
  return (
    <div className="score-sheet-wrap">
      {state !== 'done' && <div className={`${state.startsWith('error') ? 'err' : 'dim'}`} data-testid={`${testId}-state`}>{state === 'rendering' ? '악보 렌더 중…' : state}</div>}
      {'kind' in score && <div className="drum-legend" data-testid="drum-legend"><b>Drum legend / 범례</b><p>Upper instruments: voice 1 ↑ · Kick / pedal HH: voice 2 ↓</p>{score.legend.map(k => { const d=DRUM_INSTRUMENTS[k]; return <span key={k}>{d.label}: position {d.line}, {d.head} {d.symbol} · </span>; })}<p>타격 음가 = 리듬 표기. ○/＋ = HH 종류; choke 재생 길이는 표기하지 않음. Velocity 원본 보존, 고스트·악센트 추정 없음.</p></div>}
      {score.diagnostics.some(d=>d.level !== 'info') && <div className="print-score-warnings" role="alert"><b>주의 / INCOMPLETE SCORE — 표기 누락·제약</b><ul>{score.diagnostics.filter(d=>d.level !== 'info').map((d,i)=><li key={i}>[{d.code}] {d.bar ? `마디 ${d.bar}: ` : ''}{d.message}</li>)}</ul></div>}
      <div ref={el} className="score-sheet" data-testid={testId} data-state={state} />
    </div>
  );
}

export function Diagnostics({ list }: { list: NotationDiagnostic[] }) {
  if (!list.length) return <div className="dim no-print">진단 없음</div>;
  return (
    <ul className="score-diags no-print" aria-label="악보 변환 진단">
      {list.map((d, i) => <li key={i} className={d.level === 'error' ? 'err' : d.level === 'warn' ? 'warn' : 'dim'} data-code={d.code}>[{d.level}] {d.code}{d.bar ? ` (마디 ${d.bar})` : ''}: {d.message}</li>)}
    </ul>
  );
}

/** 검증 화면: 4·5·6현/사용자 튜닝, TAB·오선·둘 다, 리듬·붙임줄·박자·템포, 주법, 여러 페이지 */
export function ScoreCheck() {
  const cases = useMemo(() => checkCases().filter(c=>!new URLSearchParams(location.search).has('scoreCase') || c.id===new URLSearchParams(location.search).get('scoreCase')).map((c) => ({ ...c, result: buildBassNotation(c.project, c.options) })), []);
  const drums = useMemo(()=>drumCheckCases().filter(c=>!new URLSearchParams(location.search).has('scoreCase') || c.id===new URLSearchParams(location.search).get('scoreCase')).map(c=>({...c,result:buildDrumNotation(c.project,c.options)})),[]);
  return (
    <div className="page col score-check">
      <div className="row no-print"><h1>악보 출력 검증 (alphaTab 1.8.4, 렌더 전용)</h1><button onClick={() => window.print()}>인쇄 / PDF 저장</button><a href="#/" className="dim">돌아가기</a></div>
      {drums.map(c=><section key={c.id} className="score-case" data-testid={`case-${c.id}`}><h2 className="no-print">{c.id}</h2>{c.result.ok ? <><Diagnostics list={c.result.score.diagnostics}/><ScoreSheet score={c.result.score} testId={`sheet-${c.id}`}/></> : <Diagnostics list={c.result.diagnostics}/>}</section>)}
      {cases.map((c) => (
        <section key={c.id} className="score-case" data-testid={`case-${c.id}`}>
          <h2 className="no-print">{c.title}</h2>
          <div className="dim no-print">기대: {c.expect}</div>
          {c.result.ok ? <><Diagnostics list={c.result.score.diagnostics} /><ScoreSheet score={c.result.score} testId={`sheet-${c.id}`} /></> : <Diagnostics list={c.result.diagnostics} />}
        </section>
      ))}
    </div>
  );
}

/** 편집기 '악보' 패널: 베이스 트랙·범위·조표·보표 선택 → 진단 → 인쇄 미리보기 */
export function ScorePanel() {
  const project = useApp((s) => s.project);
  const bassTracks = (project?.tracks ?? []).filter((t) => t.kind === 'drum' || t.kind === 'tab' && t.clips.some((c) => c.kind === 'music' && (project!.sources.find((s) => s.id === c.sourceId) as { instrument?: string } | undefined)?.instrument === 'bass'));
  const [trackId, setTrackId] = useState<string>('');
  const [range, setRange] = useState<'all' | 'bars'>('all');
  const [from, setFrom] = useState(1); const [to, setTo] = useState(4);
  const [key, setKey] = useState<KeySignatureChoice>({ fifths: 0, mode: 'major' });
  const [staves, setStaves] = useState<StaveChoice>('both');
  const [preview, setPreview] = useState<NotationScore | DrumScore | null>(null);
  const [mappings, setMappings] = useState<DrumMappings>({});
  const tid = bassTracks.some(t=>t.id===trackId) ? trackId : bassTracks[0]?.id || '';
  const isDrum = project?.tracks.find(t=>t.id===tid)?.kind === 'drum';
  const pads = (project?.sources ?? []).filter(s=>s.kind==='drum' && project?.tracks.find(t=>t.id===tid)?.clips.some(c=>c.kind==='music' && c.sourceId===s.id)).flatMap(s=>s.kind==='drum' ? s.pads.map(p=>({source:s.id,pad:p})) : []);
  const result = useMemo(() => project && tid ? isDrum ? buildDrumNotation(project, {trackId:tid, mappings, ...(range === 'bars' ? { startBar: from, endBar: to } : {})}) : buildBassNotation(project, { trackId: tid, key, staves, ...(range === 'bars' ? { startBar: from, endBar: to } : {}) }) : null, [project, tid, key, staves, range, from, to, isDrum, mappings]);
  if (!project) return null;
  if (!bassTracks.length) return <div className="dim">베이스 TAB 또는 드럼 트랙이 없습니다.</div>;
  const lastBar = result?.ok ? result.score.endBar : 1;
  return (
    <div className="col">
      <div className="row">
        <label className="row">트랙 <select aria-label="악보 트랙" value={tid} onChange={(e) => setTrackId(e.target.value)}>{bassTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="row">범위 <select aria-label="악보 범위" value={range} onChange={(e) => setRange(e.target.value as 'all' | 'bars')}><option value="all">전체 곡</option><option value="bars">마디 범위</option></select></label>
        {range === 'bars' && <>
          <label className="row">시작 마디 <input type="number" min={1} aria-label="시작 마디" value={from} onChange={(e) => setFrom(Math.max(1, Math.round(Number(e.target.value) || 1)))} /></label>
          <label className="row">끝 마디 <input type="number" min={1} aria-label="끝 마디" value={to} onChange={(e) => setTo(Math.max(1, Math.round(Number(e.target.value) || 1)))} /></label>
        </>}
        {!isDrum && <><label className="row">조표 <select aria-label="조표" value={`${key.fifths}:${key.mode}`} onChange={(e) => { const [f, m] = e.target.value.split(':'); setKey({ fifths: Number(f), mode: m as 'major' | 'minor' }); }}>
          <optgroup label="장조">{KEYS.map((k) => <option key={`M${k.fifths}`} value={`${k.fifths}:major`}>{k.label} major ({sig(k.fifths)})</option>)}</optgroup>
          <optgroup label="단조">{KEYS.map((k, i) => <option key={`m${k.fifths}`} value={`${k.fifths}:minor`}>{MINOR[i]} minor ({sig(k.fifths)})</option>)}</optgroup>
        </select></label>
        <label className="row">보표 <select aria-label="보표" value={staves} onChange={(e) => setStaves(e.target.value as StaveChoice)}><option value="both">TAB + 오선보</option><option value="tab">TAB</option><option value="score">오선보(낮은음자리표)</option></select></label></>}
        <button className="primary" disabled={!result?.ok} onClick={() => result?.ok && setPreview(result.score)}>악보 미리보기</button>
      </div>
      {isDrum && <div className="col"><span>드럼 5선보 · 타악기 음자리표. MIDI 기본 추정은 아래 padId별로 변경할 수 있습니다(이번 출력 설정, 프로젝트에 저장하지 않음).</span>{pads.map(({source,pad})=>{ const k=drumPadKey(source,pad.id); return <label key={k}>{pad.name} ({pad.id}) <select aria-label={`기보 악기 ${pad.name}`} value={mappings[k] ?? suggestDrumInstrument(pad)} onChange={e=>setMappings({...mappings,[k]:e.target.value as DrumInstrument | ''})}><option value="">미매핑 — 진단 표시</option>{Object.entries(DRUM_INSTRUMENTS).map(([id,d])=><option key={id} value={id}>{d.label} ({d.line}, {d.head} {d.symbol})</option>)}</select></label>;})}</div>}
      <div className="dim">{isDrum ? '드럼 타격으로 별도 기보 모델을 만듭니다. 원본·재생 이벤트 변경 없음.' : '원본 TAB에서 별도 기보 모델을 만들어 출력합니다. 베이스 오선보는 실제 음보다 한 옥타브 위에 적습니다.'} {result?.ok ? `마디 ${result.score.startBar}–${result.score.endBar}` : ''}{range === 'all' && result?.ok ? ` (곡 끝 마디 ${lastBar})` : ''}</div>
      {result && (result.ok ? <Diagnostics list={result.score.diagnostics} /> : <Diagnostics list={result.diagnostics} />)}
      {preview && <PrintPreview score={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PrintPreview({ score, onClose }: { score: NotationScore | DrumScore; onClose: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { document.body.classList.add('score-printing'); return () => document.body.classList.remove('score-printing'); }, []);
  return createPortal(
    <div className="print-overlay" role="dialog" aria-label="악보 인쇄 미리보기">
      <div className="row no-print print-toolbar">
        <b>{score.title} — {score.trackName}</b>
        <button className="primary" disabled={!ready} onClick={() => window.print()}>인쇄 / PDF로 저장</button>
        <button onClick={onClose}>닫기</button>
        <span className="dim">브라우저 인쇄 창에서 "PDF로 저장"을 고르면 PDF 파일이 됩니다. A4 세로.</span>
      </div>
      <ScoreSheet score={score} testId="print-sheet" onReady={setReady} />
    </div>,
    document.body,
  );
}

export function barsOf(project: Project) { return new MeterMap(project.meterMap); }
