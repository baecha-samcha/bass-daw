import { useEffect, useState } from 'react';
import type { AudioClip } from '@bass-daw/schemas';
import type { WaveformPyramid } from '@bass-daw/audio-engine';
import { pickLevel } from '@bass-daw/audio-engine';
import { useApp } from '../store.ts';
import { loadPyramid } from '../audio/media.ts';

export function usePyramid(clip: AudioClip): { pyr: WaveformPyramid | null; rate: number } {
  const { project, store } = useApp();
  const src = project?.sources.find((s) => s.id === clip.sourceId);
  const asset = src?.kind === 'audio' ? project?.assets.find((a) => a.id === src.assetId) : undefined;
  const [pyr, setPyr] = useState<WaveformPyramid | null>(null);
  useEffect(() => { if (store && asset) void loadPyramid(store, asset.sha256, asset.mediaType).then(setPyr); }, [store, asset?.sha256]);
  return { pyr, rate: asset?.audio?.sampleRate ?? 48000 };
}

export function Waveform({ clip, x, y, width, height, color = '#111b' }: { clip: AudioClip; x: number; y: number; width: number; height: number; color?: string }) {
  const { pyr } = usePyramid(clip);
  if (!pyr || width < 2) return null;
  const fpp = clip.sourceFrameCount / width;
  const lvl = pickLevel(pyr, fpp);
  const cols = Math.min(Math.floor(width), 4000);
  let d = '';
  for (let i = 0; i < cols; i++) {
    const f0 = clip.sourceStartFrame + (i / cols) * clip.sourceFrameCount;
    const f1 = clip.sourceStartFrame + ((i + 1) / cols) * clip.sourceFrameCount;
    let mn = 0, mx = 0;
    for (let b = Math.floor(f0 / lvl.bucket); b <= Math.min(lvl.min.length - 1, Math.floor(f1 / lvl.bucket)); b++) { mn = Math.min(mn, lvl.min[b]); mx = Math.max(mx, lvl.max[b]); }
    const cx = x + (i / cols) * width;
    d += `M${cx.toFixed(1)} ${(y + height / 2 - mx * clip.gain * height / 2).toFixed(1)}V${(y + height / 2 - mn * clip.gain * height / 2).toFixed(1)}`;
  }
  return <path d={d} stroke={color} strokeWidth={1} pointerEvents="none" />;
}
