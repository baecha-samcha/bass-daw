import { useState } from 'react';
import type { DrumSource } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import { editNotes, useClipSource, EditorBar } from './ClipEditor.tsx';

const ROW = 26;

export function DrumEditor({ clipId, tick }: { clipId: string; tick: number }) {
  const ctx = useClipSource(clipId);
  const { selection, readOnly } = useApp();
  const [step, setStep] = useState(240);
  const [cell, setCell] = useState(22);
  const src = ctx?.source?.kind === 'drum' ? (ctx.source as DrumSource) : null;
  const clip = ctx?.clip.kind === 'music' ? ctx.clip : null;
  if (!src || !clip) return null;
  const steps = Math.floor(src.lengthTicks / step);
  const W = steps * cell;
  const playTick = tick - clip.startTick + clip.sourceOffsetTick;
  const hitAt = (padId: string, t: number) => src.hits.find((h) => h.padId === padId && h.tick >= t && h.tick < t + step);
  const sel = src.hits.find((h) => selection.noteIds.includes(h.id));

  const toggle = (padId: string, i: number, accent: boolean) => {
    if (readOnly) return;
    const t = i * step;
    const h = hitAt(padId, t);
    if (h) { editNotes(clipId, [{ op: 'delete', collection: 'hits', id: h.id }], 'Remove hit'); return; }
    const id = uuid();
    if (editNotes(clipId, [{ op: 'add', collection: 'hits', item: { id, tick: t, padId, velocity: accent ? 127 : 100 } }], 'Add hit')) useApp.getState().select({ noteIds: [id] });
  };
  const onKey = (e: React.KeyboardEvent, padId: string, i: number) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(padId, i, e.shiftKey); }
  };

  return (
    <div className="col">
      <EditorBar>
        <b>{ctx!.track.name}</b><span className="dim">드럼 스텝</span>
        <label className="row">스텝 <select value={step} onChange={(e) => setStep(Number(e.target.value))} aria-label="스텝 크기"><option value={480}>1/8</option><option value={240}>1/16</option><option value={120}>1/32</option><option value={320}>1/8T</option><option value={160}>1/16T</option></select></label>
        <button className="small" onClick={() => setCell(Math.max(10, cell - 4))} aria-label="축소">－</button>
        <button className="small" onClick={() => setCell(Math.min(48, cell + 4))} aria-label="확대">＋</button>
        <label className="row dim">마디 <input type="number" min={1} max={256} aria-label="패턴 길이(마디)" key={src.lengthTicks} defaultValue={src.lengthTicks / 3840} onBlur={(e) => useApp.getState().run('Pattern length', { type: 'SetSourceProps', clipId, props: { lengthTicks: Math.max(1, Number(e.target.value)) * 3840 } })} /></label>
        {sel && <label className="row">세기 <input type="number" min={1} max={127} key={`v${sel.id}${sel.velocity}`} defaultValue={sel.velocity} onBlur={(e) => editNotes(clipId, [{ op: 'update', collection: 'hits', id: sel.id, patch: { velocity: Math.max(1, Math.min(127, Number(e.target.value))) } }], 'Velocity')} aria-label="선택 hit velocity" /></label>}
      </EditorBar>
      <div style={{ display: 'flex', overflowX: 'auto' }}>
        <div style={{ flex: 'none', width: 90 }}>
          {src.pads.map((p) => <div key={p.id} style={{ height: ROW, lineHeight: `${ROW}px`, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} className="mono" title={p.name}>{p.name}{p.chokeGroup !== null ? ` ⓒ${p.chokeGroup}` : ''}</div>)}
        </div>
        <div role="grid" aria-label="드럼 스텝 그리드. Enter/Space 로 토글, Shift 는 강세" style={{ position: 'relative', width: W, flex: 'none' }}>
          {src.pads.map((p) => (
            <div key={p.id} role="row" style={{ display: 'flex', height: ROW }}>
              {Array.from({ length: steps }, (_, i) => {
                const h = hitAt(p.id, i * step);
                const beat = (i * step) % 960 === 0;
                return (
                  <button key={i} role="gridcell" aria-pressed={!!h} aria-label={`${p.name} ${i + 1}`} tabIndex={i === 0 ? 0 : -1}
                    onClick={(e) => { if (h && !e.shiftKey && !selection.noteIds.includes(h.id)) { useApp.getState().select({ noteIds: [h.id] }); return; } toggle(p.id, i, e.shiftKey); }}
                    onKeyDown={(e) => onKey(e, p.id, i)}
                    style={{ width: cell, minHeight: 0, height: ROW - 2, margin: '1px 0', padding: 0, borderRadius: 3, background: h ? `rgba(224,122,95,${0.35 + h.velocity / 200})` : beat ? '#2a2e37' : '#1f2229', outline: h && selection.noteIds.includes(h.id) ? '2px solid #fff' : undefined }} />
                );
              })}
            </div>
          ))}
          {playTick >= 0 && playTick < src.lengthTicks && <div style={{ position: 'absolute', top: 0, bottom: 0, left: (playTick / step) * cell, width: 2, background: '#e07a5f', pointerEvents: 'none' }} />}
        </div>
      </div>
      <div className="grid-help">셀 클릭: hit 추가/선택, 선택된 hit 다시 클릭: 삭제 · Shift+클릭: 강세(127) · choke 그룹(ⓒ) pad 는 같은 그룹의 이전 소리를 끊습니다(예: open/closed HH).</div>
    </div>
  );
}
