import { useEffect, useRef, useState } from 'react';
import type { TabNote, TabSource, TabStrum, Technique } from '@bass-daw/schemas';
import { uuid, STANDARD_TUNINGS } from '@bass-daw/schemas';
import { GUITAR_CHORDS } from '@bass-daw/tab-engine';
import type { NoteOp } from '@bass-daw/project-core';
import { useApp } from '../store.ts';
import { editNotes, useClipSource, NOTE_LENGTHS, EditorBar } from './ClipEditor.tsx';

const ROW = 26;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pname = (m: number) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

const TUNINGS: Record<string, { label: string; inst: 'bass' | 'guitar'; t: number[] }> = {
  bass4: { label: 'Bass 4 (EADG)', inst: 'bass', t: [...STANDARD_TUNINGS.bass4] },
  bass5: { label: 'Bass 5 (BEADG)', inst: 'bass', t: [...STANDARD_TUNINGS.bass5] },
  bassDropD: { label: 'Bass Drop D', inst: 'bass', t: [26, 33, 38, 43] },
  guitar6: { label: 'Guitar 6 (EADGBE)', inst: 'guitar', t: [...STANDARD_TUNINGS.guitar6] },
  guitar7: { label: 'Guitar 7 (BEADGBE)', inst: 'guitar', t: [...STANDARD_TUNINGS.guitar7] },
  guitarDropD: { label: 'Guitar Drop D', inst: 'guitar', t: [38, 45, 50, 55, 59, 64] },
};

interface Drag { ids: string[]; x0: number; y0: number; dx: number; dy: number; mode: 'move' | 'resize' }

export function TabEditor({ clipId, tick }: { clipId: string; tick: number }) {
  const ctx = useClipSource(clipId);
  const { selection, snap, readOnly } = useApp();
  const [tool, setTool] = useState<'note' | 'strum'>('note');
  const [fret, setFret] = useState(0);
  const [len, setLen] = useState(480);
  const [ppb, setPpb] = useState(64);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [chord, setChord] = useState('Em');
  const typed = useRef<{ s: string; at: number }>({ s: '', at: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const src = ctx?.source?.kind === 'tab' ? (ctx.source as TabSource) : null;
  const clip = ctx?.clip.kind === 'music' ? ctx.clip : null;
  const selIds = selection.noteIds;
  const selNotes = src ? src.notes.filter((n) => selIds.includes(n.id)) : [];
  const selStrum = src ? src.strums.find((s) => selIds.includes(s.id)) : undefined;

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (!svgRef.current?.contains(document.activeElement) && document.activeElement !== svgRef.current) return;
      const ops: NoteOp[] = [];
      if (/^[0-9]$/.test(e.key) && selNotes.length) {
        const now = performance.now();
        const s = now - typed.current.at < 700 ? typed.current.s + e.key : e.key;
        typed.current = { s, at: now };
        const f = Math.min(src.maxFret, Number(s));
        for (const n of selNotes) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { fret: f } });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        for (const n of selNotes) ops.push({ op: 'delete', collection: 'notes', id: n.id });
        if (selStrum) ops.push({ op: 'delete', collection: 'strums', id: selStrum.id });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * snap;
        for (const n of selNotes) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { tick: Math.max(0, n.tick + d) } });
        if (selStrum) ops.push({ op: 'update', collection: 'strums', id: selStrum.id, patch: { tick: Math.max(0, selStrum.tick + d) } });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const d = e.key === 'ArrowUp' ? 1 : -1;
        for (const n of selNotes) { const si = n.stringIndex + d; if (si >= 0 && si < src.tuning.length) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { stringIndex: si } }); }
      } else if (e.key === '[' || e.key === ']') {
        for (const n of selNotes) ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { durationTicks: Math.max(snap, n.durationTicks + (e.key === ']' ? snap : -snap)) } });
      } else return;
      e.preventDefault();
      editNotes(clipId, ops, 'TAB edit');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!src || !clip) return null;
  const k = ppb / 960;
  const nStr = src.tuning.length;
  const H = nStr * ROW + 24;
  const W = src.lengthTicks * k;
  const y = (si: number) => 18 + (nStr - 1 - si) * ROW + ROW / 2; // 높은 현이 위
  const snapT = (t: number) => Math.max(0, Math.round(t / snap) * snap);
  const playTick = tick - clip.startTick + clip.sourceOffsetTick;

  const pointToCell = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const t = Math.floor((e.clientX - r.left) / k / snap) * snap;
    const si = nStr - 1 - Math.floor((e.clientY - r.top - 18) / ROW);
    return { t, si };
  };

  const addAt = (e: React.MouseEvent) => {
    if (readOnly) return;
    const { t, si } = pointToCell(e);
    if (si < 0 || si >= nStr || t >= src.lengthTicks) return;
    if (tool === 'note') {
      const id = uuid();
      const d = Math.min(len, src.lengthTicks - t);
      if (editNotes(clipId, [{ op: 'add', collection: 'notes', item: { id, tick: t, durationTicks: d, stringIndex: si, fret: Math.min(fret, src.maxFret), velocity: 100, techniques: [] } }], 'Add TAB note')) useApp.getState().select({ noteIds: [id] });
    } else {
      const shape = GUITAR_CHORDS[chord] ?? [];
      const strings = Array.from({ length: nStr }, (_, i) => ({ stringIndex: i, fret: shape[i] === undefined ? null : shape[i], velocity: 100 })).filter((s) => i0(s, shape));
      const id = uuid();
      const d = Math.min(len, src.lengthTicks - t);
      if (editNotes(clipId, [{ op: 'add', collection: 'strums', item: { id, tick: t, durationTicks: d, chordName: chord, strings, direction: 'down', spreadMs: 12, accent: 1, arpeggio: null } satisfies TabStrum }], 'Add strum')) useApp.getState().select({ noteIds: [id] });
    }
  };
  const i0 = (s: { stringIndex: number }, shape: (number | null)[]) => s.stringIndex < shape.length;

  const onNoteDown = (e: React.PointerEvent, id: string, mode: Drag['mode']) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const ids = e.shiftKey ? (selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id]) : selIds.includes(id) ? selIds : [id];
    useApp.getState().select({ noteIds: ids });
    if (!readOnly) setDrag({ ids, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, mode });
  };
  const dragDelta = (d: Drag) => ({ dt: Math.round(d.dx / k / snap) * snap, ds: -Math.round(d.dy / ROW) });
  const onUp = () => {
    if (!drag) return;
    const { dt, ds } = dragDelta(drag);
    setDrag(null);
    if (!dt && !ds) return;
    const ops: NoteOp[] = [];
    for (const n of src.notes) if (drag.ids.includes(n.id)) {
      if (drag.mode === 'resize') ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { durationTicks: Math.max(snap, n.durationTicks + dt) } });
      else ops.push({ op: 'update', collection: 'notes', id: n.id, patch: { tick: Math.max(0, n.tick + dt), stringIndex: Math.max(0, Math.min(nStr - 1, n.stringIndex + ds)) } });
    }
    for (const s of src.strums) if (drag.ids.includes(s.id)) {
      if (drag.mode === 'resize') ops.push({ op: 'update', collection: 'strums', id: s.id, patch: { durationTicks: Math.max(snap, s.durationTicks + dt) } });
      else ops.push({ op: 'update', collection: 'strums', id: s.id, patch: { tick: Math.max(0, s.tick + dt) } });
    }
    editNotes(clipId, ops, drag.mode === 'resize' ? 'Resize' : 'Move notes');
  };

  const d = drag ? dragDelta(drag) : { dt: 0, ds: 0 };
  const bars = Math.ceil(src.lengthTicks / 3840);

  return (
    <div className="col">
      <EditorBar>
        <b>{ctx!.track.name}</b><span className="dim">TAB · {src.instrument} · {nStr}현</span>
        <button className={tool === 'note' ? 'on small' : 'small'} onClick={() => setTool('note')}>노트</button>
        <button className={tool === 'strum' ? 'on small' : 'small'} onClick={() => setTool('strum')} disabled={src.instrument !== 'guitar' && nStr < 6}>코드/스트로크</button>
        {tool === 'note' ? <label className="row">프렛 <input type="number" min={0} max={src.maxFret} value={fret} onChange={(e) => setFret(Number(e.target.value))} aria-label="입력 프렛" /></label>
          : <label className="row">코드 <select value={chord} onChange={(e) => setChord(e.target.value)} aria-label="코드 모양">{Object.keys(GUITAR_CHORDS).map((c) => <option key={c}>{c}</option>)}</select></label>}
        <label className="row">길이 <select value={len} onChange={(e) => setLen(Number(e.target.value))} aria-label="노트 길이">{NOTE_LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="row dim">튜닝 <select aria-label="튜닝" value={Object.keys(TUNINGS).find((x) => TUNINGS[x].t.join() === src.tuning.join()) ?? ''} onChange={(e) => {
          const t = TUNINGS[e.target.value]; if (!t) return;
          useApp.getState().run('Tuning', { type: 'SetSourceProps', clipId, props: { tuning: t.t } });
        }}><option value="">custom</option>{Object.entries(TUNINGS).filter(([, v]) => v.inst === src.instrument).map(([k2, v]) => <option key={k2} value={k2}>{v.label}</option>)}</select></label>
        <label className="row dim">마디 <input type="number" min={1} max={256} aria-label="source 길이(마디)" key={bars} defaultValue={bars} onBlur={(e) => useApp.getState().run('Source length', { type: 'SetSourceProps', clipId, props: { lengthTicks: Math.max(1, Number(e.target.value)) * 3840 } })} /></label>
        <button className="small" onClick={() => setPpb(Math.max(16, ppb / 1.5))} aria-label="편집기 축소">－</button>
        <button className="small" onClick={() => setPpb(Math.min(400, ppb * 1.5))} aria-label="편집기 확대">＋</button>
      </EditorBar>
      <div style={{ overflowX: 'auto' }}>
        <svg ref={svgRef} width={W + 40} height={H} tabIndex={0} role="grid" aria-label="TAB 편집 그리드. 빈 칸 클릭으로 노트 추가, 숫자키로 프렛, 화살표로 이동, Delete 삭제"
          onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}
          style={{ background: '#15171c', touchAction: 'none' }}>
          {Array.from({ length: Math.ceil(src.lengthTicks / 960) + 1 }, (_, i) => <line key={i} x1={i * 960 * k} x2={i * 960 * k} y1={14} y2={H - 6} stroke={i % 4 === 0 ? '#556' : '#2c303a'} />)}
          {Array.from({ length: bars }, (_, i) => <text key={i} x={i * 3840 * k + 3} y={11} fontSize={10} fill="#9aa0ab">{i + 1}</text>)}
          {src.tuning.map((p, si) => (
            <g key={si}>
              <line x1={0} x2={W} y1={y(si)} y2={y(si)} stroke="#4a5060" />
              <rect x={0} y={y(si) - ROW / 2} width={W} height={ROW} fill="transparent" onClick={addAt} data-testid={`tab-row-${si}`} />
              <text x={W + 4} y={y(si) + 4} fontSize={10} fill="#9aa0ab">{pname(p)}</text>
            </g>
          ))}
          {clip.sourceOffsetTick > 0 && <rect x={0} y={14} width={clip.sourceOffsetTick * k} height={H - 20} fill="#0006" pointerEvents="none" />}
          {src.strums.map((s) => {
            const moving = drag?.ids.includes(s.id);
            const x = (s.tick + (moving && drag!.mode === 'move' ? d.dt : 0)) * k;
            const w = Math.max(6, (s.durationTicks + (moving && drag!.mode === 'resize' ? d.dt : 0)) * k);
            const isSel = selIds.includes(s.id);
            return (
              <g key={s.id}>
                <rect x={x} y={14} width={w} height={H - 20} rx={4} fill={isSel ? '#4f86c655' : '#ffffff14'} stroke={isSel ? '#4f86c6' : '#666'} onPointerDown={(e) => onNoteDown(e, s.id, 'move')} />
                <text x={x + 3} y={H - 8} fontSize={10} fill="#e8e6df" pointerEvents="none">{s.chordName ?? 'chord'} {s.arpeggio ? 'arp' : s.direction === 'down' ? '↓' : '↑'}</text>
                {s.strings.map((st) => <text key={st.stringIndex} x={x + 4} y={y(st.stringIndex) + 4} fontSize={12} fill={st.fret === null ? '#e5534b' : '#fff'} pointerEvents="none">{st.fret === null ? 'x' : st.fret}</text>)}
                <rect x={x + w - 5} y={14} width={5} height={H - 20} fill="#fff3" style={{ cursor: 'ew-resize' }} onPointerDown={(e) => onNoteDown(e, s.id, 'resize')} />
              </g>
            );
          })}
          {src.notes.map((n) => {
            const moving = drag?.ids.includes(n.id);
            const t = n.tick + (moving && drag!.mode === 'move' ? d.dt : 0);
            const si = Math.max(0, Math.min(nStr - 1, n.stringIndex + (moving && drag!.mode === 'move' ? d.ds : 0)));
            const w = Math.max(10, (n.durationTicks + (moving && drag!.mode === 'resize' ? d.dt : 0)) * k);
            const isSel = selIds.includes(n.id);
            const tech = techLabel(n.techniques);
            return (
              <g key={n.id} data-testid={`tab-note-${n.id}`}>
                <rect x={t * k} y={y(si) - 9} width={w} height={18} rx={4} fill={isSel ? '#4f86c6' : '#e07a5f'} opacity={0.35 + n.velocity / 200} stroke={isSel ? '#fff' : 'none'}
                  onPointerDown={(e) => onNoteDown(e, n.id, 'move')} aria-label={`현 ${si + 1} 프렛 ${n.fret}`} />
                <text x={t * k + 3} y={y(si) + 4} fontSize={12} fontWeight={700} fill="#111" pointerEvents="none">{n.fret}{tech}</text>
                <rect x={t * k + w - 5} y={y(si) - 9} width={5} height={18} fill="#0005" style={{ cursor: 'ew-resize' }} onPointerDown={(e) => onNoteDown(e, n.id, 'resize')} />
              </g>
            );
          })}
          {playTick >= 0 && playTick <= src.lengthTicks && <line x1={playTick * k} x2={playTick * k} y1={14} y2={H} stroke="#e07a5f" pointerEvents="none" />}
        </svg>
      </div>
      {selNotes.length > 0 && <NoteInspector clipId={clipId} src={src} notes={selNotes} />}
      {selStrum && <StrumInspector clipId={clipId} src={src} s={selStrum} />}
      <div className="grid-help">클릭: 추가 · 드래그: 이동(세로=현 변경) · 오른쪽 끝 드래그: 길이 · 숫자키: 프렛 · ←→: 이동 · ↑↓: 현 · [ ]: 길이 · Delete: 삭제 · Shift+클릭: 다중 선택. 지원 주법: mute/slap/pop은 합성 샘플(bass), hammer-on/pull-off는 약한 재어택, slide/bend는 pitch glide로 근사 — 실제 legato·주법 샘플이 아닙니다.</div>
    </div>
  );
}

function techLabel(t: Technique[]): string {
  return t.map((x) => ({ mute: 'x', slap: 'S', pop: 'P', 'hammer-on': 'h', 'pull-off': 'p', slide: '/', bend: 'b' } as Record<string, string>)[x.kind]).join('');
}

function NoteInspector({ clipId, src, notes }: { clipId: string; src: TabSource; notes: TabNote[] }) {
  const n = notes[0];
  const upd = (patch: Partial<TabNote>, label = 'Edit note') => editNotes(clipId, notes.map((x) => ({ op: 'update' as const, collection: 'notes' as const, id: x.id, patch })), label);
  const next = src.notes.find((m) => m.stringIndex === n.stringIndex && m.tick === n.tick + n.durationTicks);
  const has = (k: string) => n.techniques.some((t) => t.kind === k);
  const setTech = (kind: string, on: boolean) => {
    const rest = n.techniques.filter((t) => t.kind !== kind && !(on && ['hammer-on', 'pull-off', 'slide'].includes(kind) && ['hammer-on', 'pull-off', 'slide'].includes(t.kind)));
    let add: Technique | null = null;
    if (on) {
      if (kind === 'hammer-on' || kind === 'pull-off' || kind === 'slide') { if (!next) return useApp.getState().toast('warn', '같은 현에서 이 노트 끝에 바로 이어지는 다음 노트가 필요합니다.'); add = { kind, targetNoteId: next.id }; }
      else if (kind === 'bend') add = { kind: 'bend', points: [{ offsetTick: 0, semitones: 0 }, { offsetTick: Math.max(1, Math.floor(n.durationTicks / 2)), semitones: 2 }] };
      else add = { kind: kind as 'mute' | 'slap' | 'pop' };
    }
    editNotes(clipId, [{ op: 'update', collection: 'notes', id: n.id, patch: { techniques: add ? [...rest, add] : rest } }], 'Technique');
  };
  return (
    <div className="card row" style={{ marginTop: 6 }} role="group" aria-label="노트 속성">
      <b>{notes.length > 1 ? `${notes.length}개 노트` : `노트 (${pname(src.tuning[n.stringIndex] + n.fret)})`}</b>
      <label className="row">현 <select value={n.stringIndex} onChange={(e) => upd({ stringIndex: Number(e.target.value) })} aria-label="현">{src.tuning.map((p, i) => <option key={i} value={i}>{i + 1} ({pname(p)})</option>)}</select></label>
      <label className="row">프렛 <input type="number" min={0} max={src.maxFret} key={`f${n.fret}`} defaultValue={n.fret} onBlur={(e) => upd({ fret: Number(e.target.value) })} aria-label="프렛" /></label>
      <label className="row">시작(박) <input type="number" step={0.25} min={0} key={`t${n.tick}`} defaultValue={n.tick / 960} onBlur={(e) => upd({ tick: Math.round(Number(e.target.value) * 960) })} aria-label="시작 박" /></label>
      <label className="row">길이(박) <input type="number" step={0.25} min={0.01} key={`d${n.durationTicks}`} defaultValue={n.durationTicks / 960} onBlur={(e) => upd({ durationTicks: Math.max(1, Math.round(Number(e.target.value) * 960)) })} aria-label="길이 박" /></label>
      <label className="row">세기 <input type="range" min={1} max={127} key={`v${n.velocity}`} defaultValue={n.velocity} onPointerUp={(e) => upd({ velocity: Number((e.target as HTMLInputElement).value) }, 'Velocity')} onKeyUp={(e) => upd({ velocity: Number((e.target as HTMLInputElement).value) }, 'Velocity')} aria-label="velocity" /> <span className="mono">{n.velocity}</span></label>
      {notes.length === 1 && ['mute', 'slap', 'pop', 'hammer-on', 'pull-off', 'slide', 'bend'].map((kind) => (
        <label key={kind} className="row"><input type="checkbox" checked={has(kind)} onChange={(e) => setTech(kind, e.target.checked)} />{kind}</label>
      ))}
    </div>
  );
}

function StrumInspector({ clipId, src, s }: { clipId: string; src: TabSource; s: TabStrum }) {
  const upd = (patch: Partial<TabStrum>, label = 'Edit strum') => editNotes(clipId, [{ op: 'update', collection: 'strums', id: s.id, patch }], label);
  const strings = src.tuning.map((_, i) => s.strings.find((x) => x.stringIndex === i) ?? null);
  const setString = (i: number, v: { fret?: number | null; velocity?: number; played?: boolean }) => {
    let list = [...s.strings];
    const cur = list.find((x) => x.stringIndex === i);
    if (v.played === false) list = list.filter((x) => x.stringIndex !== i);
    else if (!cur) list.push({ stringIndex: i, fret: v.fret === undefined ? 0 : v.fret, velocity: v.velocity ?? 100 });
    else list = list.map((x) => (x.stringIndex === i ? { ...x, ...('fret' in v ? { fret: v.fret! } : {}), ...(v.velocity ? { velocity: v.velocity } : {}) } : x));
    list.sort((a, b) => a.stringIndex - b.stringIndex);
    const arp = s.arpeggio ? { ...s.arpeggio, order: s.arpeggio.order.filter((o) => list.some((x) => x.stringIndex === o)) } : null;
    upd({ strings: list, arpeggio: arp });
  };
  return (
    <div className="card col" style={{ marginTop: 6 }} role="group" aria-label="스트로크 속성">
      <div className="row">
        <b>코드</b>
        <input aria-label="코드 이름(보조)" key={s.chordName ?? ''} defaultValue={s.chordName ?? ''} onBlur={(e) => upd({ chordName: e.target.value || null })} style={{ width: 80 }} />
        <select aria-label="코드 모양 적용" value="" onChange={(e) => { const shape = GUITAR_CHORDS[e.target.value]; if (shape) upd({ chordName: e.target.value, strings: shape.map((f, i) => ({ stringIndex: i, fret: f, velocity: 100 })).filter((x) => x.stringIndex < src.tuning.length), arpeggio: null }); }}>
          <option value="">모양 적용…</option>{Object.keys(GUITAR_CHORDS).map((c) => <option key={c}>{c}</option>)}
        </select>
        <button className={s.direction === 'down' && !s.arpeggio ? 'on small' : 'small'} onClick={() => upd({ direction: 'down', arpeggio: null })}>↓ 다운</button>
        <button className={s.direction === 'up' && !s.arpeggio ? 'on small' : 'small'} onClick={() => upd({ direction: 'up', arpeggio: null })}>↑ 업</button>
        <button className={s.arpeggio ? 'on small' : 'small'} onClick={() => upd({ arpeggio: s.arpeggio ? null : { order: s.strings.filter((x) => x.fret !== null).map((x) => x.stringIndex), stepTicks: 240 } })}>아르페지오</button>
        <label className="row">현 간격(ms) <input type="number" min={0} max={100} step={1} key={`sp${s.spreadMs}`} defaultValue={s.spreadMs} onBlur={(e) => upd({ spreadMs: Math.max(0, Math.min(100, Number(e.target.value))) })} aria-label="현 사이 간격 ms" /></label>
        <label className="row">강세 <input type="number" min={0} max={2} step={0.05} key={`ac${s.accent}`} defaultValue={s.accent} onBlur={(e) => upd({ accent: Math.max(0, Math.min(2, Number(e.target.value))) })} aria-label="전체 강세" /></label>
        <label className="row">길이(박) <input type="number" step={0.25} min={0.01} key={`d${s.durationTicks}`} defaultValue={s.durationTicks / 960} onBlur={(e) => upd({ durationTicks: Math.max(1, Math.round(Number(e.target.value) * 960)) })} aria-label="스트로크 길이" /></label>
      </div>
      <table><thead><tr><th>현</th><th>연주</th><th>프렛</th><th>뮤트(x)</th><th>세기</th></tr></thead><tbody>
        {strings.map((st, i) => (
          <tr key={i}>
            <td>{i + 1} ({pname(src.tuning[i])})</td>
            <td><input type="checkbox" checked={!!st} onChange={(e) => setString(i, { played: e.target.checked })} aria-label={`현 ${i + 1} 연주`} /></td>
            <td>{st && <input type="number" min={0} max={src.maxFret} disabled={st.fret === null} key={`f${st.fret}`} defaultValue={st.fret ?? 0} onBlur={(e) => setString(i, { fret: Number(e.target.value) })} aria-label={`현 ${i + 1} 프렛`} />}</td>
            <td>{st && <input type="checkbox" checked={st.fret === null} onChange={(e) => setString(i, { fret: e.target.checked ? null : 0 })} aria-label={`현 ${i + 1} 뮤트`} />}</td>
            <td>{st && <input type="number" min={1} max={127} key={`v${st.velocity}`} defaultValue={st.velocity} onBlur={(e) => setString(i, { velocity: Math.max(1, Math.min(127, Number(e.target.value))) })} aria-label={`현 ${i + 1} 세기`} />}</td>
          </tr>
        ))}
      </tbody></table>
      {s.arpeggio && (
        <div className="row">
          <label className="row">순서(현 번호, 쉼표) <input aria-label="아르페지오 순서" key={s.arpeggio.order.join()} defaultValue={s.arpeggio.order.map((x) => x + 1).join(',')} onBlur={(e) => upd({ arpeggio: { ...s.arpeggio!, order: e.target.value.split(',').map((x) => Number(x.trim()) - 1).filter((x) => s.strings.some((q) => q.stringIndex === x)) } })} /></label>
          <label className="row">간격 <select aria-label="아르페지오 간격" value={s.arpeggio.stepTicks} onChange={(e) => upd({ arpeggio: { ...s.arpeggio!, stepTicks: Number(e.target.value) } })}>{NOTE_LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
      )}
      <div className="grid-help">뮤트한 현(x)은 발음하지 않습니다. 팜뮤트·데드 스트로크 전용 음원은 아직 지원하지 않습니다.</div>
    </div>
  );
}
