import { useEffect, useState } from 'react';
import type { Channel, PluginInstance } from '@bass-daw/schemas';
import { BUILTIN_DESCRIPTORS, uuid } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';
import { useEngineStatus } from './hooks.ts';
import { PluginUiFrame } from './PluginUi.tsx';
import type { InstalledPlugin } from '@bass-daw/plugin-api';

function pinCommand(x: InstalledPlugin) { return { type: 'SetMetadata' as const, key: `pluginHash:${x.key}`, value: x.bundleHash }; }

function insertExternal(channelId: string, key: string) {
  const x = useApp.getState().installedPlugins.find((p) => p.key === key); if (!x) return;
  useApp.getState().run(`Insert ${x.manifest.name}`, { type: 'Batch', commands: [
    pinCommand(x),
    { type: 'InsertEffect', channelId, pluginId: x.manifest.pluginId, instanceId: uuid(), state: { version: x.manifest.stateVersion }, external: { pluginVersion: x.manifest.version, stateVersion: x.manifest.stateVersion, parameters: Object.fromEntries(x.manifest.parameters.map((d) => [d.id, d.default])) } },
  ] });
}

function InstrumentSelect({ channel }: { channel: Channel }) {
  const project = useApp((s) => s.project)!;
  const installed = useApp((s) => s.installedPlugins).filter((x) => x.manifest.role === 'instrument');
  const track = project.tracks.find((t) => t.channelId === channel.id);
  if (!track || track.kind === 'audio') return null;
  const pl = project.plugins.find((x) => x.instanceId === track.instrumentSlot);
  const audioAssets = project.assets.filter((a) => a.audio);
  const ext = pl && !pl.pluginId.startsWith('builtin.') ? installed.find((x) => x.key === `${pl.pluginId}@${pl.pluginVersion}`) : undefined;
  const choose = (key: string) => {
    if (key === 'builtin.sampler') return useApp.getState().toast('info', '내장 샘플러로 되돌리려면 Undo 를 사용하세요(키트 매핑 보존).');
    const x = installed.find((p) => p.key === key); if (!x) return;
    const asset = audioAssets[0];
    useApp.getState().run(`Instrument ${x.manifest.name}`, { type: 'Batch', commands: [pinCommand(x), { type: 'SetInstrument', trackId: track.id, plugin: { instanceId: uuid(), pluginId: x.manifest.pluginId, pluginVersion: x.manifest.version, stateVersion: x.manifest.stateVersion, role: 'instrument', state: { version: x.manifest.stateVersion }, parameters: Object.fromEntries(x.manifest.parameters.map((d) => [d.id, d.default])), assets: asset && x.manifest.permissions.includes('read-selected-assets') ? [asset.id] : [] } }] });
  };
  return (
    <div className="col">
      <label className="col dim">Instrument
        <select aria-label={`${channel.name} instrument`} value={pl ? (pl.pluginId === 'builtin.sampler' ? 'builtin.sampler' : `${pl.pluginId}@${pl.pluginVersion}`) : ''} onChange={(e) => choose(e.target.value)}>
          <option value="builtin.sampler">내장 Sampler</option>
          {pl && !pl.pluginId.startsWith('builtin.') && !ext && <option value={`${pl.pluginId}@${pl.pluginVersion}`}>{pl.pluginId}@{pl.pluginVersion} (missing)</option>}
          {installed.map((x) => <option key={x.key} value={x.key}>{x.manifest.name}</option>)}
        </select>
      </label>
      {ext && pl && ext.manifest.permissions.includes('read-selected-assets') && (
        <label className="col dim">Sample (사용자 선택)
          <select aria-label={`${channel.name} sample`} value={pl.assets[0] ?? ''} onChange={(e) => useApp.getState().run('Select sample', { type: 'SetPluginState', instanceId: pl.instanceId, state: pl.state, assets: e.target.value ? [e.target.value] : [] })}>
            <option value="">(없음)</option>{audioAssets.map((a) => <option key={a.id} value={a.id}>{a.sha256.slice(0, 8)} · {(a.audio!.frameCount / a.audio!.sampleRate).toFixed(2)}s</option>)}
          </select>
        </label>
      )}
      {ext && pl && ext.manifest.parameters.map((d) => (
        <label key={d.id} className="col" style={{ fontSize: 11 }}>{d.name}: {(pl.parameters[d.id] ?? d.default).toFixed(2)}
          <input type="range" min={d.min} max={d.max} step={d.steps ? (d.max - d.min) / (d.steps - 1) : (d.max - d.min) / 200} defaultValue={pl.parameters[d.id] ?? d.default} key={`${d.id}${pl.parameters[d.id]}`} aria-label={`${ext.manifest.name} ${d.name}`}
            onPointerUp={(e) => useApp.getState().run(d.name, { type: 'SetParameter', owner: 'plugin', ownerId: pl.instanceId, parameterId: d.id, value: Number((e.target as HTMLInputElement).value) })} />
        </label>
      ))}
    </div>
  );
}

const db = (g: number) => (g <= 0 ? '-∞' : (20 * Math.log10(g)).toFixed(1));

export function Mixer() {
  const project = useApp((s) => s.project);
  const [peaks, setPeaks] = useState<{ master: [number, number]; channels: [number, number][] } | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => engine.onMeters((p) => setPeaks(p)), []);
  useEffect(() => { setOrder(engine.channelOrder()); }, [project, peaks === null]);
  if (!project) return null;
  const trackOf = (c: Channel) => project.tracks.find((t) => t.channelId === c.id);
  const sorted = [...project.channels].sort((a, b) => rank(a) - rank(b) || (trackOf(a)?.order ?? 0) - (trackOf(b)?.order ?? 0));
  const peakOf = (id: string) => { const i = order.indexOf(id); return i >= 0 ? peaks?.channels[i] : undefined; };
  return (
    <div className="col">
      <div className="row">
        <button className="small" onClick={() => useApp.getState().run('Add bus', { type: 'CreateBus', name: `Bus ${project.channels.filter((c) => c.kind === 'bus').length + 1}`, busId: uuid() })}>+ 버스</button>
        <span className="dim">gain/pan 조작은 5ms smoothing 으로 즉시 들리고, 손을 떼면 Undo 가능한 명령으로 저장됩니다. 자동화 lane 이 활성인 파라미터의 수동 조작은 일시 미리보기입니다.</span>
      </div>
      <div className="mixer">
        {sorted.map((c) => <Strip key={c.id} c={c} peak={c.kind === 'master' ? peaks?.master : peakOf(c.id)} />)}
      </div>
    </div>
  );
}
const rank = (c: Channel) => (c.kind === 'track' ? 0 : c.kind === 'bus' ? 1 : 2);

function Strip({ c, peak }: { c: Channel; peak?: [number, number] }) {
  const project = useApp((s) => s.project)!;
  const run = useApp.getState().run;
  const buses = project.channels.filter((x) => x.kind !== 'track' && x.id !== c.id);
  const auto = (p: string) => project.automation.some((l) => l.enabled && l.target.ownerId === c.id && l.target.parameterId === p);
  const pk = Math.max(peak?.[0] ?? 0, peak?.[1] ?? 0);
  return (
    <div className="strip" aria-label={`채널 ${c.name}`}>
      <b title={c.kind}>{c.name}</b>
      <div className={`meter ${pk > 1 ? 'clip' : ''}`} role="meter" aria-label="peak meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, Math.round(pk * 100) / 100)}><div style={{ width: `${Math.min(100, pk * 100)}%` }} /></div>
      <label className="col">Gain {db(c.gain)} dB {auto('gain') && <span className="warn">auto</span>}
        <input type="range" min={0} max={4} step={0.01} defaultValue={c.gain} key={`g${c.gain}`} aria-label={`${c.name} gain`}
          onInput={(e) => engine.previewChannel(c.id, 'gain', Number((e.target as HTMLInputElement).value))}
          onPointerUp={(e) => run('Gain', { type: 'SetParameter', owner: 'channel', ownerId: c.id, parameterId: 'gain', value: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e) => run('Gain', { type: 'SetParameter', owner: 'channel', ownerId: c.id, parameterId: 'gain', value: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <label className="col">Pan {c.pan.toFixed(2)} {auto('pan') && <span className="warn">auto</span>}
        <input type="range" min={-1} max={1} step={0.01} defaultValue={c.pan} key={`p${c.pan}`} aria-label={`${c.name} pan`}
          onInput={(e) => engine.previewChannel(c.id, 'pan', Number((e.target as HTMLInputElement).value))}
          onPointerUp={(e) => run('Pan', { type: 'SetParameter', owner: 'channel', ownerId: c.id, parameterId: 'pan', value: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e) => run('Pan', { type: 'SetParameter', owner: 'channel', ownerId: c.id, parameterId: 'pan', value: Number((e.target as HTMLInputElement).value) })} />
      </label>
      <div className="row">
        <button className={`small ${c.muted ? 'on' : ''}`} aria-pressed={c.muted} onClick={() => run('Mute', { type: 'SetChannelFlags', channelId: c.id, muted: !c.muted })}>M</button>
        {c.kind !== 'master' && <button className={`small ${c.solo ? 'on' : ''}`} aria-pressed={c.solo} onClick={() => run('Solo', { type: 'SetChannelFlags', channelId: c.id, solo: !c.solo })}>S</button>}
        {c.kind === 'bus' && <button className="small" onClick={() => run('Delete bus', { type: 'DeleteBus', channelId: c.id })} aria-label="버스 삭제">✕</button>}
      </div>
      {c.kind === 'track' && <InstrumentSelect channel={c} />}
      {c.kind !== 'master' && (
        <label className="col dim">Output
          <select value={c.output ?? ''} aria-label={`${c.name} output`} onChange={(e) => run('Route', { type: 'SetRouting', channelId: c.id, output: e.target.value })}>
            {buses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}
      {c.kind !== 'master' && (
        <div className="col">
          <span className="dim">Sends</span>
          {c.sends.map((s, i) => (
            <div key={s.id} className="row" style={{ gap: 4 }}>
              <span className="mono" style={{ fontSize: 11 }}>{project.channels.find((x) => x.id === s.targetChannelId)?.name}</span>
              <input type="range" min={0} max={4} step={0.01} defaultValue={s.gain} key={`s${s.gain}`} style={{ width: 60 }} aria-label="send gain"
                onPointerUp={(e) => run('Send', { type: 'SetRouting', channelId: c.id, sends: c.sends.map((x, k) => (k === i ? { ...x, gain: Number((e.target as HTMLInputElement).value) } : x)) })} />
              <button className="small" onClick={() => run('Send tap', { type: 'SetRouting', channelId: c.id, sends: c.sends.map((x, k) => (k === i ? { ...x, tap: x.tap === 'pre' ? 'post' : 'pre' } : x)) })}>{s.tap}</button>
              <button className="small" onClick={() => run('Remove send', { type: 'SetRouting', channelId: c.id, sends: c.sends.filter((_, k) => k !== i) })} aria-label="send 삭제">✕</button>
            </div>
          ))}
          <select value="" aria-label="send 추가" onChange={(e) => e.target.value && run('Add send', { type: 'SetRouting', channelId: c.id, sends: [...c.sends, { id: uuid(), targetChannelId: e.target.value, gain: 0.5, tap: 'post' }] })}>
            <option value="">+ send…</option>
            {project.channels.filter((x) => x.kind === 'bus' && x.id !== c.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}
      <div className="col">
        <span className="dim">Inserts</span>
        {c.effects.map((id) => { const pl = project.plugins.find((p) => p.instanceId === id); return pl ? <EffectBox key={id} channel={c} pl={pl} /> : null; })}
        <select value="" aria-label="effect 추가" onChange={(e) => { const v = e.target.value; if (!v) return; if (v.startsWith('ext:')) insertExternal(c.id, v.slice(4)); else run('Insert effect', { type: 'InsertEffect', channelId: c.id, pluginId: v }); }}>
          <option value="">+ effect…</option><option value="builtin.eq">EQ (3-band)</option><option value="builtin.compressor">Compressor</option><option value="builtin.reverb">Reverb (IR)</option>
          {useApp.getState().installedPlugins.filter((x) => x.manifest.role === 'effect').map((x) => <option key={x.key} value={`ext:${x.key}`}>{x.manifest.name} ({x.key})</option>)}
        </select>
      </div>
    </div>
  );
}

function EffectBox({ channel, pl }: { channel: Channel; pl: PluginInstance }) {
  const [open, setOpen] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [ui, setUi] = useState<string | null>(null);
  const installed = useApp((s) => s.installedPlugins).find((x) => x.key === `${pl.pluginId}@${pl.pluginVersion}`);
  const pinned = useApp((s) => s.project?.metadata[`pluginHash:${pl.pluginId}@${pl.pluginVersion}`]);
  const usable = installed && (!pinned || pinned === installed.bundleHash);
  const desc = BUILTIN_DESCRIPTORS[pl.pluginId] ?? (usable ? { parameters: installed!.manifest.parameters } : undefined);
  const fault = useEngineStatus().pluginFaults.find((f) => f.instanceId === pl.instanceId);
  const run = useApp.getState().run;
  return (
    <div className="card" style={{ padding: 6 }} data-testid={`effect-${pl.pluginId}`}>
      <div className="row" style={{ gap: 4 }}>
        <button className="small" onClick={() => setOpen(!open)} aria-expanded={open}>{installed?.manifest.name ?? pl.pluginId.replace('builtin.', '')}</button>
        {!desc && <span className="err" title="미설치(또는 hash 불일치) 플러그인 — 상태 보존, 재생 시 bypass, export 기본 차단">missing</span>}
        {fault && <span className="err" data-testid="plugin-fault" title="faulted → bypassed (자동 재시작 없음). 프로젝트를 다시 준비하면 재시도합니다.">fault: {fault.reason}</span>}
        {usable && !BUILTIN_DESCRIPTORS[pl.pluginId] && <button className={`small ${bypass ? 'on' : ''}`} aria-pressed={bypass} onClick={() => { engine.bypassPlugin(pl.instanceId, !bypass); setBypass(!bypass); }}>bypass</button>}
        {usable && installed!.manifest.ui && <button className="small" onClick={async () => { if (ui) return setUi(null); const b = await useApp.getState().pluginHost!.installedBundle(installed!.key); setUi(b?.ui ?? null); }}>UI</button>}
        <button className="small" onClick={() => run('Remove effect', { type: 'RemoveEffect', channelId: channel.id, instanceId: pl.instanceId })} aria-label="effect 삭제">✕</button>
      </div>
      {open && desc && desc.parameters.map((d) => {
        const v = pl.parameters[d.id] ?? d.default;
        const step = d.steps ? (d.max - d.min) / (d.steps - 1) : (d.max - d.min) / 200;
        return (
          <label key={d.id} className="col" style={{ fontSize: 11 }}>{d.name}: {v.toFixed(2)} {d.unit}{d.automation === 'none' ? ' (정지 중 적용)' : ''}
            <input type="range" min={d.min} max={d.max} step={step} defaultValue={v} key={`${d.id}${v}`} aria-label={`${pl.pluginId} ${d.name}`}
              onInput={(e) => d.automation !== 'none' && engine.previewEffect(channel.id, pl.instanceId, d.id, Number((e.target as HTMLInputElement).value))}
              onPointerUp={(e) => run(d.name, { type: 'SetParameter', owner: 'plugin', ownerId: pl.instanceId, parameterId: d.id, value: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => run(d.name, { type: 'SetParameter', owner: 'plugin', ownerId: pl.instanceId, parameterId: d.id, value: Number((e.target as HTMLInputElement).value) })} />
          </label>
        );
      })}
      {open && pl.pluginId === 'builtin.reverb' && <ReverbIr pl={pl} />}
      {ui && installed && <PluginUiFrame html={ui} manifest={installed.manifest} pl={pl} channelId={channel.id} />}
    </div>
  );
}

function ReverbIr({ pl }: { pl: PluginInstance }) {
  const project = useApp((s) => s.project)!;
  const irId = (pl.state as { irAssetId?: string | null })?.irAssetId ?? null;
  const audioAssets = project.assets.filter((a) => a.audio && a.audio.frameCount / a.audio.sampleRate <= 4);
  return (
    <label className="col" style={{ fontSize: 11 }}>IR
      <select value={irId ?? ''} aria-label="리버브 IR" onChange={(e) => useApp.getState().run('Reverb IR', { type: 'SetPluginState', instanceId: pl.instanceId, state: { version: 1, irAssetId: e.target.value || null }, assets: e.target.value ? [e.target.value] : [] })}>
        <option value="">합성 IR (1s, seed 고정)</option>
        {audioAssets.map((a) => <option key={a.id} value={a.id}>{a.sha256.slice(0, 8)} ({(a.audio!.frameCount / a.audio!.sampleRate).toFixed(2)}s)</option>)}
      </select>
    </label>
  );
}
