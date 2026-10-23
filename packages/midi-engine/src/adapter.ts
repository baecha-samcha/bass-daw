// MIDI / drum source → source-local 이벤트 어댑터.
import type { MidiSource, DrumSource } from '@bass-daw/schemas';
import type { SourceEvent, SourceCompileResult } from '@bass-daw/music-core';

export function compileMidiSource(src: MidiSource): SourceCompileResult {
  const events: SourceEvent[] = [];
  for (const n of src.notes) events.push({ kind: 'note', id: n.id, tick: n.tick, durationTicks: n.durationTicks, pitch: n.pitch, velocity: n.velocity, channel: n.channel, articulation: 'normal', stringIndex: null, padId: null, timeOffsetSeconds: 0, expressions: [] });
  for (const c of src.cc) events.push({ kind: 'cc', id: c.id, tick: c.tick, channel: c.channel, controller: c.controller, value: c.value });
  for (const b of src.pitchBend) events.push({ kind: 'pitchBend', id: b.id, tick: b.tick, channel: b.channel, value: b.value });
  events.sort((a, b) => a.tick - b.tick);
  return { events, diagnostics: [] };
}

/** drum hit 은 one-shot: noteOff 는 엔진 sampler 의 pad voice 에서 무시된다. 길이는 1/16 로 둔다. */
export const DRUM_HIT_TICKS = 240;
export function compileDrumSource(src: DrumSource): SourceCompileResult {
  const pads = new Map(src.pads.map((p) => [p.id, p]));
  const events: SourceEvent[] = [];
  for (const h of src.hits) {
    const pad = pads.get(h.padId)!;
    events.push({ kind: 'note', id: h.id, tick: h.tick, durationTicks: Math.max(1, Math.min(DRUM_HIT_TICKS, src.lengthTicks - h.tick)), pitch: pad.midiPitch, velocity: h.velocity, channel: 9, articulation: 'normal', stringIndex: null, padId: h.padId, timeOffsetSeconds: 0, expressions: [] });
  }
  events.sort((a, b) => a.tick - b.tick);
  return { events, diagnostics: [] };
}
