// 02 §5 클립 전개 의미: [start,end) 반개구간, 선택 구간 안에서 시작한 노트만 emit, 끝은 클립 경계에서 truncate,
// loopSource 는 source.lengthTicks 로 wrap 하며 반복마다 occurrence 를 증가시킨다.
import type { MusicClip, Tick, Id } from '@bass-daw/schemas';
import type { PerformanceEvent, SourceEvent } from './events.ts';

export interface ClipWindow { clipStart: Tick; sourceStart: Tick; sourceEnd: Tick; occurrence: number }

/** 클립이 차지하는 source 구간 조각들 (loop 이면 여러 조각) */
export function clipWindows(clip: MusicClip, sourceLength: Tick): ClipWindow[] {
  const out: ClipWindow[] = [];
  if (!clip.loopSource) {
    out.push({ clipStart: clip.startTick, sourceStart: clip.sourceOffsetTick, sourceEnd: clip.sourceOffsetTick + clip.durationTicks, occurrence: 0 });
    return out;
  }
  let remaining = clip.durationTicks;
  let pos = clip.startTick;
  let srcPos = clip.sourceOffsetTick % sourceLength;
  let occ = 0;
  while (remaining > 0) {
    const len = Math.min(remaining, sourceLength - srcPos);
    out.push({ clipStart: pos, sourceStart: srcPos, sourceEnd: srcPos + len, occurrence: occ });
    remaining -= len; pos += len; srcPos = 0; occ++;
  }
  return out;
}

export function expandClip(trackId: Id, clip: MusicClip, sourceId: Id, sourceLength: Tick, events: readonly SourceEvent[]): PerformanceEvent[] {
  const out: PerformanceEvent[] = [];
  if (clip.muted) return out;
  const clipEnd = clip.startTick + clip.durationTicks;
  for (const w of clipWindows(clip, sourceLength)) {
    const shift = w.clipStart - w.sourceStart;
    for (const e of events) {
      if (e.tick < w.sourceStart || e.tick >= w.sourceEnd) continue;
      const tick = e.tick + shift;
      const base = { trackId, clipId: clip.id, sourceId, occurrence: w.occurrence, sourceEventId: e.id };
      if (e.kind === 'note') {
        const voiceKey = `${clip.id}/${e.id}/${w.occurrence}`;
        const end = Math.min(tick + e.durationTicks, clipEnd);
        out.push({ ...base, kind: 'noteOn', tick, timeOffsetSeconds: e.timeOffsetSeconds, voiceKey, pitch: e.pitch, velocity: e.velocity, channel: e.channel, articulation: e.articulation, stringIndex: e.stringIndex, padId: e.padId });
        for (const x of e.expressions) {
          const xt = tick + x.offsetTick;
          if (xt < end) out.push({ ...base, kind: 'expression', tick: xt, timeOffsetSeconds: x.offsetTick === 0 ? e.timeOffsetSeconds : 0, voiceKey, parameterId: x.parameterId, value: x.value });
        }
        out.push({ ...base, kind: 'noteOff', tick: end, timeOffsetSeconds: end === tick + e.durationTicks ? e.timeOffsetSeconds : 0, voiceKey });
      } else if (e.kind === 'cc') {
        out.push({ ...base, kind: 'cc', tick, timeOffsetSeconds: 0, channel: e.channel, controller: e.controller, value: e.value });
      } else {
        out.push({ ...base, kind: 'pitchBend', tick, timeOffsetSeconds: 0, channel: e.channel, value: e.value });
      }
    }
  }
  return out;
}
