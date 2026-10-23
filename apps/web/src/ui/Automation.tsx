import { useRef, useState } from 'react';
import type { AutomationLane, Project } from '@bass-daw/schemas';
import { BUILTIN_DESCRIPTORS, CHANNEL_PARAMETERS, uuid } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import type { InstalledPlugin } from '@bass-daw/plugin-api';
import { useMaps, projectEndTick } from './hooks.ts';

interface Target { owner: 'channel' | 'plugin'; ownerId: string; parameterId: string; label: string; min: number; max: number; def: number }

function targets(p: Project, installed: InstalledPlugin[] = []): Target[] {
  const out: Target[] = [];
  for (const c of p.channels) for (const d of CHANNEL_PARAMETERS) out.push({ owner: 'channel', ownerId: c.id, parameterId: d.id, label: `${c.name} · ${d.name}`, min: d.min, max: d.max, def: d.id === 'gain' ? c.gain : c.pan });
  for (const pl of p.plugins) {
    const desc = BUILTIN_DESCRIPTORS[pl.pluginId] ?? installed.find((x) => x.key === `${pl.pluginId}@${pl.pluginVersion}`)?.manifest; if (!desc) continue;
    const where = p.channels.find((c) => c.effects.includes(pl.instanceId))?.name ?? p.tracks.find((t) => t.instrumentSlot === pl.instanceId)?.name ?? '?';
    for (const d of desc.parameters) if (d.automation !== 'none') out.push({ owner: 'plugin', ownerId: pl.instanceId, parameterId: d.id, label: `${where} · ${pl.pluginId.replace('builtin.', '')} · ${d.name}`, min: d.min, max: d.max, def: pl.parameters[d.id] ?? d.default });
  }
  return out;
}

export function AutomationPanel() {
  const project = useApp((s) => s.project);
  const installed = useApp((s) => s.installedPlugins);
  const [add, setAdd] = useState('');
  if (!project) return null;
  const ts = targets(project, installed);
  const key = (t: { owner: string; ownerId: string; parameterId: string }) => `${t.owner}|${t.ownerId}|${t.parameterId}`;
  const free = ts.filter((t) => !project.automation.some((l) => key(l.target) === key(t)));
  return (
    <div className="col">
      <div className="row">
        <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="자동화 대상"><option value="">자동화 대상 선택…</option>{free.map((t) => <option key={key(t)} value={key(t)}>{t.label}</option>)}</select>
        <button disabled={!add} onClick={() => { const t = ts.find((x) => key(x) === add)!; useApp.getState().run('Add automation', { type: 'EditAutomation', op: 'upsert', lane: { id: uuid(), target: { owner: t.owner, ownerId: t.ownerId, parameterId: t.parameterId }, enabled: true, points: [{ tick: 0, value: t.def, interpolation: 'linear' }] } }); setAdd(''); }}>lane 추가</button>
        <span className="dim">v1: read/off 만 지원(실시간 녹화 없음). 점: 클릭 추가 · 드래그 이동 · 더블클릭 step/linear 전환 · Alt+클릭 삭제.</span>
      </div>
      {project.automation.map((l) => { const t = ts.find((x) => key(x) === key(l.target)); return <Lane key={l.id} lane={l} t={t} />; })}
    </div>
  );
}

function Lane({ lane, t }: { lane: AutomationLane; t?: Target }) {
  const project = useApp((s) => s.project)!;
  const { pxPerBeat, snap } = useApp();
  const maps = useMaps(project)!;
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ i: number; dx: number; dy: number; x0: number; y0: number } | null>(null);
  const H = 70; const k = pxPerBeat / 960; const W = projectEndTick(project, maps.tm) * k;
  const min = t?.min ?? 0, max = t?.max ?? 1;
  const vy = (v: number) => H - 4 - ((v - min) / (max - min)) * (H - 8);
  const yv = (y: number) => Math.max(min, Math.min(max, min + ((H - 4 - y) / (H - 8)) * (max - min)));
  const save = (points: AutomationLane['points'], label = 'Edit automation') => {
    const sorted = [...points].sort((a, b) => a.tick - b.tick).filter((p, i, a) => i === 0 || p.tick !== a[i - 1].tick);
    useApp.getState().run(label, { type: 'EditAutomation', op: 'upsert', lane: { ...lane, points: sorted } });
  };
  const pts = lane.points.map((p, i) => (drag?.i === i ? { ...p, tick: Math.max(0, Math.round((p.tick + drag.dx / k) / snap) * snap), value: yv(vy(p.value) + drag.dy) } : p));
  let d = '';
  pts.forEach((p, i) => { const x = p.tick * k, y = vy(p.value); if (i === 0) d += `M0 ${vy(t?.def ?? p.value)} L${x} ${vy(t?.def ?? p.value)} M${x} ${y}`; const nx = pts[i + 1]; if (nx) d += p.interpolation === 'linear' ? ` L${nx.tick * k} ${vy(nx.value)}` : ` L${nx.tick * k} ${y} L${nx.tick * k} ${vy(nx.value)}`; else d += ` L${W} ${y}`; });
  return (
    <div className="card" style={{ padding: 6 }}>
      <div className="row">
        <b style={{ fontSize: 12 }}>{t?.label ?? `${lane.target.ownerId}:${lane.target.parameterId}`}</b>
        <button className={`small ${lane.enabled ? 'on' : ''}`} onClick={() => useApp.getState().run('Automation read/off', { type: 'EditAutomation', op: 'upsert', lane: { ...lane, enabled: !lane.enabled } })} aria-pressed={lane.enabled}>{lane.enabled ? 'read' : 'off'}</button>
        <button className="small" onClick={() => useApp.getState().run('Delete lane', { type: 'EditAutomation', op: 'delete', laneId: lane.id })}>삭제</button>
        <span className="dim mono">{lane.points.length} pts · 범위 {min}..{max}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg ref={svg} width={W} height={H} style={{ background: '#15171c', touchAction: 'none', opacity: lane.enabled ? 1 : 0.5 }} aria-label="자동화 lane"
          onClick={(e) => { if (drag) return; const r = svg.current!.getBoundingClientRect(); const tick = Math.max(0, Math.round((e.clientX - r.left) / k / snap) * snap); save([...lane.points.filter((p) => p.tick !== tick), { tick, value: yv(e.clientY - r.top), interpolation: 'linear' }], 'Add point'); }}
          onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })}
          onPointerUp={() => { if (drag && (Math.abs(drag.dx) > 2 || Math.abs(drag.dy) > 2)) save(pts, 'Move point'); setTimeout(() => setDrag(null), 0); }}>
          <path d={d} stroke="#e3b341" fill="none" strokeWidth={1.5} />
          {pts.map((p, i) => (
            <circle key={i} cx={p.tick * k} cy={vy(p.value)} r={5} fill={p.interpolation === 'linear' ? '#e3b341' : '#4f86c6'} stroke="#000"
              onPointerDown={(e) => { e.stopPropagation(); if (e.altKey) { save(lane.points.filter((_, j) => j !== i), 'Delete point'); return; } (e.target as Element).setPointerCapture(e.pointerId); setDrag({ i, dx: 0, dy: 0, x0: e.clientX, y0: e.clientY }); }}
              onDoubleClick={(e) => { e.stopPropagation(); save(lane.points.map((q, j) => (j === i ? { ...q, interpolation: q.interpolation === 'linear' ? 'step' : 'linear' } : q)), 'Interpolation'); }}
              onClick={(e) => e.stopPropagation()}>
              <title>{`tick ${p.tick} · ${p.value.toFixed(3)} · ${p.interpolation}`}</title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  );
}
