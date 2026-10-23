import type { AudioClip } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import { useClipSource, EditorBar } from './ClipEditor.tsx';
import { Waveform } from './Waveform.tsx';
import { useMaps } from './hooks.ts';

export function AudioClipEditor({ clipId, tick }: { clipId: string; tick: number }) {
  const ctx = useClipSource(clipId);
  const project = useApp((s) => s.project);
  const maps = useMaps(project);
  if (!ctx || ctx.clip.kind !== 'audio' || !maps) return null;
  const c = ctx.clip as AudioClip;
  const asset = ctx.source?.kind === 'audio' ? ctx.project.assets.find((a) => a.id === (ctx.source as { assetId: string }).assetId) : undefined;
  const sr = asset?.audio?.sampleRate ?? 48000;
  const run = useApp.getState().run;
  const W = 900, H = 120;
  const dur = c.sourceFrameCount / sr;
  const playSec = maps.tm.tickToSeconds(tick) - c.startSeconds;
  return (
    <div className="col">
      <EditorBar>
        <b>{ctx.track.name}</b><span className="dim">오디오 클립 · {c.name}</span>
        <label className="row">시작(초) <input type="number" step={0.001} min={0} key={`s${c.startSeconds}`} defaultValue={c.startSeconds.toFixed(3)} onBlur={(e) => run('Move clip', { type: 'MoveClip', clipId, startSeconds: Math.max(0, Number(e.target.value)) })} aria-label="시작 초" /></label>
        <label className="row">앞 트림(초) <input type="number" step={0.001} key={`ts${c.sourceStartFrame}`} defaultValue={(c.sourceStartFrame / sr).toFixed(3)} onBlur={(e) => { const delta = Number(e.target.value) - c.sourceStartFrame / sr; run('Trim', { type: 'TrimClip', clipId, edge: 'start', seconds: c.startSeconds + delta }); }} aria-label="원본 선택 시작 초" /></label>
        <label className="row">길이(초) <input type="number" step={0.001} key={`d${c.sourceFrameCount}`} defaultValue={dur.toFixed(3)} onBlur={(e) => run('Trim', { type: 'TrimClip', clipId, edge: 'end', seconds: c.startSeconds + Number(e.target.value) })} aria-label="길이 초" /></label>
        <label className="row">Gain <input type="range" min={0} max={4} step={0.01} key={`g${c.gain}`} defaultValue={c.gain} onPointerUp={(e) => run('Clip gain', { type: 'SetClipProps', clipId, props: { gain: Number((e.target as HTMLInputElement).value) } })} onKeyUp={(e) => run('Clip gain', { type: 'SetClipProps', clipId, props: { gain: Number((e.target as HTMLInputElement).value) } })} aria-label="클립 gain" /><span className="mono">{c.gain.toFixed(2)}</span></label>
        <label className="row">Fade in(ms) <input type="number" min={0} key={`fi${c.fadeInFrames}`} defaultValue={Math.round((c.fadeInFrames / sr) * 1000)} onBlur={(e) => run('Fade', { type: 'SetClipProps', clipId, props: { fadeInFrames: Math.max(0, Math.round((Number(e.target.value) / 1000) * sr)) } })} aria-label="fade in ms" /></label>
        <label className="row">Fade out(ms) <input type="number" min={0} key={`fo${c.fadeOutFrames}`} defaultValue={Math.round((c.fadeOutFrames / sr) * 1000)} onBlur={(e) => run('Fade', { type: 'SetClipProps', clipId, props: { fadeOutFrames: Math.max(0, Math.round((Number(e.target.value) / 1000) * sr)) } })} aria-label="fade out ms" /></label>
        <button className="small" onClick={() => { if (!run('Split', { type: 'SplitClip', clipId, seconds: maps.tm.tickToSeconds(tick) })) useApp.getState().toast('warn', '재생 위치가 클립 안에 있어야 합니다.'); }}>재생위치 분할</button>
      </EditorBar>
      <svg width={W} height={H} style={{ background: '#15171c', maxWidth: '100%' }} viewBox={`0 0 ${W} ${H}`} aria-label="파형">
        <Waveform clip={c} x={0} y={0} width={W} height={H} color="#6fbf73" />
        {c.fadeInFrames > 0 && <path d={`M0 ${H} L${(c.fadeInFrames / c.sourceFrameCount) * W} 0`} stroke="#e3b341" fill="none" />}
        {c.fadeOutFrames > 0 && <path d={`M${W - (c.fadeOutFrames / c.sourceFrameCount) * W} 0 L${W} ${H}`} stroke="#e3b341" fill="none" />}
        {playSec >= 0 && playSec <= dur && <line x1={(playSec / dur) * W} x2={(playSec / dur) * W} y1={0} y2={H} stroke="#e07a5f" />}
      </svg>
      <div className="grid-help mono">원본: {asset?.sha256.slice(0, 16)}… · {asset?.audio?.channels === 2 ? 'stereo' : 'mono'} · {sr}Hz · 원본 frames {asset?.audio?.frameCount} · 선택 [{c.sourceStartFrame}, {c.sourceStartFrame + c.sourceFrameCount}) — 편집은 선택 구간만 바꾸며 원본 바이트는 변경하지 않습니다(초 앵커: 템포를 바꿔도 시작 초·길이 유지).</div>
    </div>
  );
}
