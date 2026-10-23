import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine, type EngineStatus } from '../audio/engine.ts';
import { TempoMap, MeterMap } from '@bass-daw/music-core';
import type { Project } from '@bass-daw/schemas';

export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.status);
}

/** rAF 로 재생 위치(tick) 를 읽는다. React 재렌더를 오디오 클럭으로 쓰지 않는다. */
export function usePlayhead(): number {
  const [tick, setTick] = useState(0);
  const st = useEngineStatus();
  useEffect(() => {
    let raf = 0; let last = -1;
    const loop = () => { const t = engine.currentTick(); if (Math.abs(t - last) > 1) { last = t; setTick(t); } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [st.state]);
  return tick;
}

export function useMaps(p: Project | null) {
  const ref = useRef<{ key: unknown; tm: TempoMap; mm: MeterMap } | null>(null);
  if (!p) return null;
  if (!ref.current || ref.current.key !== p.tempoMap) ref.current = { key: p.tempoMap, tm: new TempoMap(p.tempoMap), mm: new MeterMap(p.meterMap) };
  if (ref.current.mm.points !== p.meterMap) ref.current.mm = new MeterMap(p.meterMap);
  return ref.current;
}

export function fmtPos(mm: MeterMap, tick: number): string {
  const b = mm.tickToBarBeat(Math.max(0, Math.floor(tick)));
  return `${b.bar}.${b.beat}.${String(Math.floor(b.tickInBeat)).padStart(3, '0')}`;
}

export function projectEndTick(p: Project, tm: TempoMap): number {
  return Math.max(960 * 4 * 16, songEndTick(p, tm)) + 960 * 4 * 4;
}

/** 마지막 클립 끝(Tick) */
export function songEndTick(p: Project, tm: TempoMap): number {
  let end = 960;
  for (const t of p.tracks) for (const c of t.clips) {
    if (c.kind === 'music') end = Math.max(end, c.startTick + c.durationTicks);
    else {
      const s = p.sources.find((x) => x.id === c.sourceId); const a = s?.kind === 'audio' ? p.assets.find((x) => x.id === s.assetId) : null;
      if (a?.audio) end = Math.max(end, Math.ceil(tm.secondsToTick(c.startSeconds + c.sourceFrameCount / a.audio.sampleRate)));
    }
  }
  return end;
}
