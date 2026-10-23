import { useEffect, useRef, useState } from 'react';
import type { MidiSource, MidiNote } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import type { NoteOp } from '@bass-daw/project-core';
import { useApp } from '../store.ts';
import { editNotes, useClipSource, NOTE_LENGTHS, EditorBar } from './ClipEditor.tsx';

const KEY_H = 12;
const LO = 21, HI = 108;
const VEL_H = 60;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);

interface Drag { ids: string[]; x0: number; y0: number; dx: number; dy: number; mode: 'move' | 'resize' | 'vel'; vel0?: number }

export function PianoRoll({ clipId, tick }: { clipId: string; tick: number }) {
  const ctx = useClipSource(clipId);
  const { selection, snap, readOnly } = useApp();
  const [len, setLen] = useState(480);
  const [ppb, setPpb] = useState(64);
  const [channel, setChannel] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const src = ctx?.source?.kind === 'midi' ? (ctx.source as MidiSource) : null;
  const clip = ctx?.clip.kind === 'music' ? ctx.clip : null;
  const selIds = selection.noteIds;
  const selNotes = src ? src.notes.filter((n) => selIds.includes(n.id)) : [];

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = (HI - 72) * KEY_H; }, [clipId]);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement !== svgRef.current) return;
      const ops: NoteOp[] = [];
      if (e.key === 'Delete' || e.key === 'Backspace') selNotes.forEach((n) => ops.push({ op: 'delete', collection: 'notes', id: n.id }));
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1); selNotes.forEach((n) => ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { pitch: Math.max(0, Math.min(127, n.pitch + d)) } })); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const d = (e.key === 'ArrowLeft' ? -1 : 1) * snap; selNotes.forEach((n) => ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { tick: Math.max(0, n.tick + d) } })); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { useApp.getState().select({ noteIds: src.notes.map((n) => n.id) }); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      editNotes(clipId, ops, 'Piano roll edit');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  if (!src || !clip) return null;
  const k = ppb / 960;
  const W = src.lengthTicks * k;
  const rows = HI - LO + 1;
  const H = rows * KEY_H;
  const y = (p: number) => (HI - p) * KEY_H;
  const snapT = (t: number) => Math.max(0, Math.round(t / snap) * snap);
  const playTick = tick - clip.startTick + clip.sourceOffsetTick;

  const add = (e: React.MouseEvent) => {
    if (readOnly) return;
    const r = svgRef.current!.getBoundingClientRect();
    const t = Math.floor((e.clientX - r.left) / k / snap) * snap;
    const p = HI - Math.floor((e.clientY - r.top) / KEY_H);
    if (t >= src.lengthTicks || p < 0 || p > 127) return;
    const id = uuid();
    if (editNotes(clipId, [{ op: 'add', collection: 'notes', item: { id, tick: t, durationTicks: Math.min(len, src.lengthTicks - t), pitch: p, velocity: 100, channel } satisfies MidiNote }], 'Add note')) useApp.getState().select({ noteIds: [id] });
  };
  const down = (e: React.PointerEvent, id: string, mode: Drag['mode']) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const ids = e.shiftKey ? (selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id]) : selIds.includes(id) ? selIds : [id];
    useApp.getState().select({ noteIds: ids });
    if (!readOnly) setDrag({ ids, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, mode, vel0: src.notes.find((n) => n.id === id)?.velocity });
  };
  const delta = (d: Drag) => ({ dt: Math.round(d.dx / k / snap) * snap, dp: -Math.round(d.dy / KEY_H), dv: -Math.round(d.dy * 127 / VEL_H) });
  const up = () => {
    if (!drag) return;
    const { dt, dp, dv } = delta(drag); setDrag(null);
    const ops: NoteOp[] = [];
    for (const n of src.notes) if (drag.ids.includes(n.id)) {
      if (drag.mode === 'move' && (dt || dp)) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { tick: Math.max(0, n.tick + dt), pitch: Math.max(0, Math.min(127, n.pitch + dp)) } });
      if (drag.mode === 'resize' && dt) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { durationTicks: Math.max(1, n.durationTicks + dt) } });
      if (drag.mode === 'vel' && dv) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { velocity: Math.max(1, Math.min(127, n.velocity + dv)) } });
    }
    editNotes(clipId, ops, drag.mode === 'vel' ? 'Velocity' : drag.mode === 'resize' ? 'Resize' : 'Move notes');
  };
  const d = drag ? delta(drag) : { dt: 0, dp: 0, dv: 0 };
  const sustain = src.cc.filter((c) => c.controller === 64).sort((a, b) => a.tick - b.tick);

  return (
    <div className="col">
      <EditorBar>
        <b>{ctx!.track.name}</b><span className="dim">피아노 롤</span>
        <label className="row">길이 <select value={len} onChange={(e) => setLen(Number(e.target.value))} aria-label="노트 길이">{NOTE_LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="row">MIDI ch <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} aria-label="MIDI 채널">{Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
        <button className="small" onClick={() => setPpb(Math.max(16, ppb / 1.5))} aria-label="편집기 축소">－</button>
        <button className="small" onClick={() => setPpb(Math.min(400, ppb * 1.5))} aria-label="편집기 확대">＋</button>
        <button className="small" onClick={() => {
          const t = Math.max(0, Math.min(src.lengthTicks - 1, snapT(playTick)));
          const on = !((sustain.filter((c) => c.tick <= t).at(-1)?.value ?? 0) >= 64);
          editNotes(clipId, [{ op: 'add', collection: 'cc', item: { id: uuid(), tick: t, channel, controller: 64, value: on ? 127 : 0 } }], 'Sustain');
        }}>재생위치 sustain 토글</button>
        <button className="small" onClick={() => {
          const t = Math.max(0, Math.min(src.lengthTicks - 1, snapT(playTick)));
          const v = Number(prompt('Pitch bend (-8192..8191)', '0'));
          if (Number.isFinite(v)) editNotes(clipId, [{ op: 'add', collection: 'pitchBend', item: { id: uuid(), tick: t, channel, value: Math.max(-8192, Math.min(8191, Math.round(v))) } }], 'Pitch bend');
        }}>재생위치 pitch bend</button>
        {selNotes.length === 1 && (
          <>
            <label className="row">음높이 <input type="number" min={0} max={127} key={`p${selNotes[0].pitch}`} defaultValue={selNotes[0].pitch} onBlur={(e) => editNotes(clipId, [{ op: 'update', collection: 'notes', id: selNotes[0].id, patch: { pitch: Number(e.target.value) } }])} aria-label="음높이" /></label>
            <label className="row">시작(박) <input type="number" step={0.25} min={0} key={`t${selNotes[0].tick}`} defaultValue={selNotes[0].tick / 960} onBlur={(e) => editNotes(clipId, [{ op: 'update', collection: 'notes', id: selNotes[0].id, patch: { tick: Math.round(Number(e.target.value) * 960) } }])} aria-label="시작 박" /></label>
            <label className="row">길이(박) <input type="number" step={0.25} min={0.01} key={`d${selNotes[0].durationTicks}`} defaultValue={selNotes[0].durationTicks / 960} onBlur={(e) => editNotes(clipId, [{ op: 'update', collection: 'notes', id: selNotes[0].id, patch: { durationTicks: Math.max(1, Math.round(Number(e.target.value) * 960)) } }])} aria-label="길이 박" /></label>
            <label className="row">세기 <input type="number" min={1} max={127} key={`v${selNotes[0].velocity}`} defaultValue={selNotes[0].velocity} onBlur={(e) => editNotes(clipId, [{ op: 'update', collection: 'notes', id: selNotes[0].id, patch: { velocity: Math.max(1, Math.min(127, Number(e.target.value))) } }])} aria-label="velocity" /></label>
          </>
        )}
      </EditorBar>
      <div ref={scrollRef} style={{ overflow: 'auto', maxHeight: 340, display: 'flex' }}>
        <svg width={36} height={H} style={{ position: 'sticky', left: 0, background: '#111', zIndex: 1, flex: 'none' }} aria-hidden>
          {Array.from({ length: rows }, (_, i) => { const p = HI - i; return <g key={p}><rect x={0} y={i * KEY_H} width={36} height={KEY_H} fill={isBlack(p) ? '#222' : '#ddd'} stroke="#555" />{p % 12 === 0 && <text x={2} y={i * KEY_H + 10} fontSize={9} fill="#333">{NAMES[0]}{p / 12 - 1}</text>}</g>; })}
        </svg>
        <svg ref={svgRef} width={W} height={H} tabIndex={0} role="grid" aria-label="피아노 롤. 클릭으로 노트 추가, 화살표 이동/조옮김, Delete 삭제"
          onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })} onPointerUp={up} onPointerCancel={() => setDrag(null)}
          style={{ background: '#15171c', touchAction: 'none', flex: 'none' }}>
          {Array.from({ length: rows }, (_, i) => <rect key={i} x={0} y={i * KEY_H} width={W} height={KEY_H} fill={isBlack(HI - i) ? '#181a20' : '#1d2027'} onClick={add} />)}
          {Array.from({ length: Math.ceil(src.lengthTicks / 960) + 1 }, (_, i) => <line key={i} x1={i * 960 * k} x2={i * 960 * k} y1={0} y2={H} stroke={i % 4 === 0 ? '#556' : '#2a2e37'} pointerEvents="none" />)}
          {src.notes.map((n) => {
            const mv = drag?.ids.includes(n.id);
            const t = n.tick + (mv && drag!.mode === 'move' ? d.dt : 0);
            const p = n.pitch + (mv && drag!.mode === 'move' ? d.dp : 0);
            const w = Math.max(4, (n.durationTicks + (mv && drag!.mode === 'resize' ? d.dt : 0)) * k);
            const sel = selIds.includes(n.id);
            return (
              <g key={n.id}>
                <rect x={t * k} y={y(p) + 1} width={w} height={KEY_H - 2} rx={2} fill={sel ? '#4f86c6' : `hsl(${200 + n.channel * 20} 60% ${30 + n.velocity / 4}%)`} stroke={sel ? '#fff' : '#0008'} onPointerDown={(e) => down(e, n.id, 'move')} aria-label={`노트 ${p}`} />
                <rect x={t * k + w - 4} y={y(p) + 1} width={4} height={KEY_H - 2} fill="#fff4" style={{ cursor: 'ew-resize' }} onPointerDown={(e) => down(e, n.id, 'resize')} />
              </g>
            );
          })}
          {playTick >= 0 && playTick <= src.lengthTicks && <line x1={playTick * k} x2={playTick * k} y1={0} y2={H} stroke="#e07a5f" pointerEvents="none" />}
        </svg>
      </div>
      <div style={{ overflowX: 'auto', marginLeft: 36 }}>
        <svg width={W} height={VEL_H + 30} onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })} onPointerUp={up} style={{ background: '#121418', touchAction: 'none' }} aria-label="velocity/CC 레인">
          {src.notes.map((n) => {
            const v = Math.max(1, Math.min(127, n.velocity + (drag?.ids.includes(n.id) && drag.mode === 'vel' ? d.dv : 0)));
            return <rect key={n.id} x={n.tick * k} y={VEL_H - (v / 127) * VEL_H} width={4} height={(v / 127) * VEL_H} fill={selIds.includes(n.id) ? '#4f86c6' : '#6fbf73'} onPointerDown={(e) => down(e, n.id, 'vel')} style={{ cursor: 'ns-resize' }} />;
          })}
          {sustain.map((c, i) => <g key={c.id}><rect x={c.tick * k} y={VEL_H + 6} width={Math.max(2, ((sustain[i + 1]?.tick ?? src.lengthTicks) - c.tick) * k)} height={8} fill={c.value >= 64 ? '#e3b341' : 'transparent'} /><text x={c.tick * k + 2} y={VEL_H + 26} fontSize={9} fill="#9aa0ab" onClick={() => editNotes(clipId, [{ op: 'delete', collection: 'cc', id: c.id }], 'Delete CC')} style={{ cursor: 'pointer' }}>{c.value >= 64 ? 'ped↓' : 'ped↑'}✕</text></g>)}
          {src.pitchBend.map((b) => <g key={b.id}><circle cx={b.tick * k} cy={VEL_H + 10 - (b.value / 8192) * 6} r={3} fill="#9b5de5" /><text x={b.tick * k + 4} y={VEL_H + 26} fontSize={9} fill="#9b5de5" onClick={() => editNotes(clipId, [{ op: 'delete', collection: 'pitchBend', id: b.id }], 'Delete bend')} style={{ cursor: 'pointer' }}>pb {b.value}✕</text></g>)}
        </svg>
      </div>
      <div className="grid-help">클릭: 추가 · 드래그: 이동 · 오른쪽 끝: 길이 · 아래 막대 드래그: velocity · ↑↓ 반음(Shift 옥타브) · ←→ snap 이동 · Ctrl+A 전체 · Delete. Sustain(CC64)·pitch bend 는 채널별로 저장·재생됩니다.</div>
    </div>
  );
}
