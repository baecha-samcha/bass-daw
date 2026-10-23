import { useRef, useState } from 'react';
import type { Clip, Track, Project } from '@bass-daw/schemas';
import type { CommandPayload } from '@bass-daw/project-core';
import { TempoMap } from '@bass-daw/music-core';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';
import { useMaps, projectEndTick } from './hooks.ts';
import { Waveform } from './Waveform.tsx';

const LANE_H = 56;
const RULER_H = 28;

interface Drag { kind: 'move' | 'trim-start' | 'trim-end'; clipIds: string[]; startX: number; dx: number; trackDy: number; startY: number }

export function clipSpan(p: Project, tm: TempoMap, c: Clip): [number, number] {
  if (c.kind === 'music') return [c.startTick, c.startTick + c.durationTicks];
  const s = p.sources.find((x) => x.id === c.sourceId); const a = s?.kind === 'audio' ? p.assets.find((x) => x.id === s.assetId) : null;
  const dur = a?.audio ? c.sourceFrameCount / a.audio.sampleRate : 1;
  return [tm.secondsToTick(c.startSeconds), tm.secondsToTick(c.startSeconds + dur)];
}

export function Timeline({ tick }: { tick: number }) {
  const { project, selection, pxPerBeat, snap, readOnly } = useApp();
  const maps = useMaps(project)!;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  if (!project) return null;
  const k = pxPerBeat / 960;
  const end = projectEndTick(project, maps.tm);
  const width = end * k;
  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
  const bars = maps.mm.barLines(0, end);
  const run = useApp.getState().run;
  const sel = selected.length ? selected : selection.clipId ? [selection.clipId] : [];

  const snapT = (t: number) => Math.max(0, Math.round(t / snap) * snap);
  const deltaTicks = (d: Drag) => d.dx / k;

  // 혼합 선택 이동: 음악은 Tick 양자화, 오디오는 같은 이동량을 초로 변환(02 §2). preview 후 원자적 확정.
  const planMove = (d: Drag): { cmds: CommandPayload[]; quantNote: string } => {
    const cmds: CommandPayload[] = [];
    let maxQ = 0;
    const lead = findClip(project, d.clipIds[0]);
    const leadStart = lead ? clipSpan(project, maps.tm, lead.clip)[0] : 0;
    const target = snapT(leadStart + deltaTicks(d));
    const dt = target - leadStart;
    for (const id of d.clipIds) {
      const f = findClip(project, id); if (!f) continue;
      const toTrack = d.clipIds.length === 1 ? tracks[Math.max(0, Math.min(tracks.length - 1, tracks.indexOf(f.track) + d.trackDy))] : f.track;
      const toTrackId = toTrack.kind === f.track.kind ? toTrack.id : undefined;
      if (f.clip.kind === 'music') cmds.push({ type: 'MoveClip', clipId: id, startTick: Math.max(0, f.clip.startTick + Math.round(dt)), toTrackId });
      else {
        const s0 = maps.tm.tickToSeconds(maps.tm.secondsToTick(f.clip.startSeconds) + dt);
        const exact = Math.max(0, s0);
        cmds.push({ type: 'MoveClip', clipId: id, startSeconds: exact, toTrackId });
        maxQ = Math.max(maxQ, Math.abs(maps.tm.secondsToTick(exact) - Math.round(maps.tm.secondsToTick(exact))));
      }
    }
    const mixed = d.clipIds.some((id) => findClip(project, id)?.clip.kind === 'audio') && d.clipIds.some((id) => findClip(project, id)?.clip.kind === 'music');
    return { cmds, quantNote: mixed ? `혼합 이동: 음악 Tick 양자화, 오디오 초 이동 (오디오 grid 오차 최대 ${maxQ.toFixed(2)} tick)` : '' };
  };

  const commitDrag = (d: Drag) => {
    if (Math.abs(d.dx) < 2 && d.trackDy === 0) return;
    if (d.kind === 'move') {
      const { cmds } = planMove(d);
      run(cmds.length > 1 ? 'Move clips' : 'Move clip', cmds.length === 1 ? cmds[0] : { type: 'Batch', commands: cmds });
      return;
    }
    const f = findClip(project, d.clipIds[0]); if (!f) return;
    const [s, e] = clipSpan(project, maps.tm, f.clip);
    const t = snapT((d.kind === 'trim-start' ? s : e) + deltaTicks(d));
    if (f.clip.kind === 'music') run('Trim clip', { type: 'TrimClip', clipId: f.clip.id, edge: d.kind === 'trim-start' ? 'start' : 'end', tick: t });
    else run('Trim clip', { type: 'TrimClip', clipId: f.clip.id, edge: d.kind === 'trim-start' ? 'start' : 'end', seconds: maps.tm.tickToSeconds(t) });
  };

  const onPointerDown = (e: React.PointerEvent, clip: Clip, track: Track, kind: Drag['kind']) => {
    if (readOnly) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    let ids = sel.includes(clip.id) ? sel : [clip.id];
    if (e.shiftKey) ids = sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id];
    setSelected(ids);
    useApp.getState().select({ trackId: track.id, clipId: clip.id, noteIds: [] });
    setDrag({ kind, clipIds: kind === 'move' ? ids : [clip.id], startX: e.clientX, dx: 0, trackDy: 0, startY: e.clientY });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dx: e.clientX - drag.startX, trackDy: drag.kind === 'move' ? Math.round((e.clientY - drag.startY) / LANE_H) : 0 });
  };
  const onPointerUp = () => { if (drag) commitDrag(drag); setDrag(null); };

  const preview = drag?.kind === 'move' ? planMove(drag) : null;
  const seek = (e: React.MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    void engine.seek(snapT((e.clientX - r.left) / k));
  };

  const selClip = sel[0] ? findClip(project, sel[0]) : null;

  return (
    <div className="col" style={{ overflow: 'hidden', minHeight: 0 }}>
      <div className="row" style={{ padding: '4px 8px', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }} role="toolbar" aria-label="타임라인 도구">
        <AddTrackMenu />
        <span className="dim">|</span>
        <button className="small" onClick={() => useApp.getState().set({ pxPerBeat: Math.max(8, pxPerBeat / 1.5) })} aria-label="축소">－</button>
        <button className="small" onClick={() => useApp.getState().set({ pxPerBeat: Math.min(400, pxPerBeat * 1.5) })} aria-label="확대">＋</button>
        <label className="row dim">Snap <select aria-label="스냅" value={snap} onChange={(e) => useApp.getState().set({ snap: Number(e.target.value) })}>
          {[[3840, '1 bar'], [960, '1/4'], [480, '1/8'], [240, '1/16'], [120, '1/32'], [320, '1/8T'], [1, 'off']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
        {selClip && (
          <>
            <span className="dim">|</span>
            <span className="dim">클립: {selClip.clip.name || selClip.clip.kind}</span>
            <button className="small" onClick={() => {
              const t = Math.round(engine.currentTick());
              const ok = selClip.clip.kind === 'music' ? run('Split', { type: 'SplitClip', clipId: selClip.clip.id, tick: snapT(t) }) : run('Split', { type: 'SplitClip', clipId: selClip.clip.id, seconds: maps.tm.tickToSeconds(t) });
              if (!ok) useApp.getState().toast('warn', '재생 위치가 클립 안에 있어야 분할됩니다.');
            }}>재생위치 분할</button>
            <button className="small" onClick={() => run('Duplicate', { type: 'DuplicateClip', clipId: selClip.clip.id })}>복제</button>
            {selClip.clip.kind === 'music' && <button className={`small ${selClip.clip.loopSource ? 'on' : ''}`} onClick={() => run('Loop clip', { type: 'SetClipProps', clipId: selClip.clip.id, props: { loopSource: !(selClip.clip as { loopSource: boolean }).loopSource } })}>클립 루프</button>}
            {selClip.clip.kind === 'music' && <label className="row dim">길이(박) <input type="number" min={1} step={1} aria-label="클립 길이(박)" key={selClip.clip.durationTicks} defaultValue={selClip.clip.durationTicks / 960} onBlur={(e) => run('Clip length', { type: 'SetClipProps', clipId: selClip.clip.id, props: { durationTicks: Math.max(1, Math.round(Number(e.target.value) * 960)) } })} /></label>}
            <button className="small" onClick={() => { run('Delete clips', sel.length > 1 ? { type: 'Batch', commands: sel.map((id) => ({ type: 'DeleteClip' as const, clipId: id })) } : { type: 'DeleteClip', clipId: selClip.clip.id }); setSelected([]); useApp.getState().select({ clipId: null }); }}>삭제</button>
          </>
        )}
        {preview?.quantNote && <span className="warn">{preview.quantNote}</span>}
      </div>
      <div className="timeline-wrap" ref={wrap} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
        <div className="track-heads">
          <div className="ruler-pad" />
          {tracks.map((t) => (
            <div key={t.id} className={`track-head ${selection.trackId === t.id ? 'sel' : ''}`} style={{ borderLeft: `4px solid ${t.color}` }} onClick={() => useApp.getState().select({ trackId: t.id })}>
              {editingName === t.id
                ? <input autoFocus aria-label="트랙 이름" defaultValue={t.name} onBlur={(e) => { run('Rename track', { type: 'RenameTrack', trackId: t.id, name: e.target.value.slice(0, 256) || t.name }); setEditingName(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                : <span className="name" onDoubleClick={() => setEditingName(t.id)} title="더블클릭/이름 버튼으로 변경">{t.name} <span className="dim mono">{t.kind}</span></span>}
              <div className="row" style={{ gap: 4 }}>
                <button className={`small ${t.muted ? 'on' : ''}`} aria-pressed={t.muted} aria-label={`${t.name} 뮤트`} onClick={(e) => { e.stopPropagation(); run('Mute', { type: 'SetTrackFlags', trackId: t.id, muted: !t.muted }); }}>M</button>
                <button className={`small ${t.solo ? 'on' : ''}`} aria-pressed={t.solo} aria-label={`${t.name} 솔로`} onClick={(e) => { e.stopPropagation(); run('Solo', { type: 'SetTrackFlags', trackId: t.id, solo: !t.solo }); }}>S</button>
                <button className="small" aria-label={`${t.name} 이름 변경`} onClick={(e) => { e.stopPropagation(); setEditingName(t.id); }}>✎</button>
                <button className="small" aria-label={`${t.name} 트랙 삭제`} onClick={(e) => { e.stopPropagation(); if (confirm(`"${t.name}" 트랙을 삭제할까요? (Undo 가능)`)) run('Delete track', { type: 'DeleteTrack', trackId: t.id }); }}>✕</button>
              </div>
            </div>
          ))}
        </div>
        <div className="lane" style={{ width }}>
          <svg width={width} height={RULER_H + tracks.length * LANE_H} role="presentation">
            <rect x={0} y={0} width={width} height={RULER_H} fill="#1b1e24" onClick={seek} style={{ cursor: 'pointer' }} data-testid="ruler" />
            {project.loop.enabled && <rect x={project.loop.startTick * k} y={0} width={(project.loop.endTick - project.loop.startTick) * k} height={RULER_H} fill="#4f86c655" pointerEvents="none" />}
            {bars.map((t) => { const b = maps.mm.tickToBarBeat(t).bar; return (
              <g key={t} pointerEvents="none">
                <line x1={t * k} x2={t * k} y1={0} y2={RULER_H + tracks.length * LANE_H} stroke="#343946" />
                {(pxPerBeat > 20 || b % 4 === 1) && <text x={t * k + 3} y={18} fill="#9aa0ab" fontSize={11}>{b}</text>}
              </g>); })}
            {tracks.map((t, i) => (
              <g key={t.id} transform={`translate(0 ${RULER_H + i * LANE_H})`}>
                <rect x={0} y={0} width={width} height={LANE_H} fill={i % 2 ? '#1a1d23' : '#1d2027'} onClick={() => { setSelected([]); useApp.getState().select({ trackId: t.id, clipId: null }); }} />
                <line x1={0} x2={width} y1={LANE_H} y2={LANE_H} stroke="#2a2e37" />
                {t.clips.map((c) => {
                  let [s, e] = clipSpan(project, maps.tm, c);
                  let dy = 0;
                  const moving = drag && drag.clipIds.includes(c.id);
                  if (moving && drag!.kind === 'move') { const d = deltaTicks(drag!); const lead = findClip(project, drag!.clipIds[0])!; const ls = clipSpan(project, maps.tm, lead.clip)[0]; const dt = snapT(ls + d) - ls; s += dt; e += dt; dy = drag!.trackDy * LANE_H; }
                  if (moving && drag!.kind === 'trim-start') s = snapT(s + deltaTicks(drag!));
                  if (moving && drag!.kind === 'trim-end') e = snapT(e + deltaTicks(drag!));
                  const isSel = sel.includes(c.id);
                  return (
                    <g key={c.id} transform={`translate(0 ${dy})`} opacity={c.muted ? 0.4 : moving ? 0.8 : 1}>
                      <rect data-testid={`clip-${c.id}`} role="button" tabIndex={0} aria-pressed={isSel} aria-label={`클립 ${c.name}`}
                        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelected([c.id]); useApp.getState().select({ trackId: t.id, clipId: c.id, noteIds: [] }); } }}
                        x={s * k} y={4} width={Math.max(4, (e - s) * k)} height={LANE_H - 8} rx={4} fill={t.color + (isSel ? 'ff' : '99')} stroke={isSel ? '#fff' : 'none'}
                        onPointerDown={(ev) => onPointerDown(ev, c, t, 'move')} style={{ cursor: 'grab', touchAction: 'none' }} />
                      {c.kind === 'audio' ? <Waveform clip={c} x={s * k} width={Math.max(4, (e - s) * k)} height={LANE_H - 8} y={4} /> : <ClipNotes project={project} clip={c} x={s * k} k={k} />}
                      <text x={s * k + 4} y={16} fontSize={11} fill="#111" pointerEvents="none">{c.name}{c.kind === 'music' && c.loopSource ? ' ⟲' : ''}</text>
                      <rect x={s * k} y={4} width={6} height={LANE_H - 8} fill="#0004" style={{ cursor: 'ew-resize', touchAction: 'none' }} onPointerDown={(ev) => onPointerDown(ev, c, t, 'trim-start')} aria-hidden="true" />
                      <rect x={e * k - 6} y={4} width={6} height={LANE_H - 8} fill="#0004" style={{ cursor: 'ew-resize', touchAction: 'none' }} onPointerDown={(ev) => onPointerDown(ev, c, t, 'trim-end')} aria-hidden="true" />
                    </g>
                  );
                })}
              </g>
            ))}
            <line x1={tick * k} x2={tick * k} y1={0} y2={RULER_H + tracks.length * LANE_H} stroke="#e07a5f" strokeWidth={2} pointerEvents="none" data-testid="playhead" />
          </svg>
        </div>
      </div>
    </div>
  );
}

function ClipNotes({ project, clip, x, k }: { project: Project; clip: Extract<Clip, { kind: 'music' }>; x: number; k: number }) {
  const s = project.sources.find((q) => q.id === clip.sourceId);
  if (!s || s.kind === 'audio') return null;
  const items: { t: number; d: number; y: number }[] = [];
  const end = clip.durationTicks;
  const push = (t: number, d: number, y: number) => {
    const len = s.lengthTicks;
    if (!clip.loopSource) { const rel = t - clip.sourceOffsetTick; if (rel >= 0 && rel < end) items.push({ t: rel, d: Math.min(d, end - rel), y }); return; }
    for (let base = -clip.sourceOffsetTick; base < end; base += len) { const rel = base + t; if (rel >= 0 && rel < end) items.push({ t: rel, d: Math.min(d, end - rel), y }); }
  };
  if (s.kind === 'tab') { for (const n of s.notes) push(n.tick, n.durationTicks, 1 - n.stringIndex / s.tuning.length); for (const st of s.strums) push(st.tick, st.durationTicks, 0.5); }
  if (s.kind === 'midi') for (const n of s.notes) push(n.tick, n.durationTicks, 1 - (n.pitch - 24) / 84);
  if (s.kind === 'drum') for (const h of s.hits) push(h.tick, 60, 1 - (s.pads.findIndex((p) => p.id === h.padId) + 1) / (s.pads.length + 1));
  return <g pointerEvents="none">{items.slice(0, 2000).map((n, i) => <rect key={i} x={x + n.t * k} y={8 + Math.max(0, Math.min(1, n.y)) * 36} width={Math.max(1, n.d * k)} height={3} fill="#111a" />)}</g>;
}

export function findClip(p: Project, id: string): { track: Track; clip: Clip } | null {
  for (const t of p.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { track: t, clip: c }; }
  return null;
}

function AddTrackMenu() {
  const add = useApp((s) => s.addInstrumentTrack);
  const n = useApp((s) => s.project?.tracks.length ?? 0);
  return (
    <div className="row" role="group" aria-label="트랙 추가">
      <span className="dim">트랙 추가:</span>
      <button className="small" disabled={n >= 128} onClick={() => add('tab', 'bass')}>+ Bass TAB</button>
      <button className="small" disabled={n >= 128} onClick={() => add('tab', 'guitar')}>+ Guitar TAB</button>
      <button className="small" disabled={n >= 128} onClick={() => add('midi')}>+ Keys</button>
      <button className="small" disabled={n >= 128} onClick={() => add('drum')}>+ Drums</button>
      <button className="small" disabled={n >= 128} onClick={() => add('audio')}>+ Audio</button>
    </div>
  );
}
