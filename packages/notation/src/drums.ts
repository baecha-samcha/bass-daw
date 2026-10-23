import type { Project, DrumPad, MusicClip } from '@bass-daw/schemas';
import { PPQ } from '@bass-daw/schemas';
import { MeterMap, TempoMap, clipWindows } from '@bass-daw/music-core';
import { decomposeTicks, type NotationDiagnostic, type NotationBeat } from './index.ts';

// Positions count down in half-line steps: 1=top line, 9=bottom line.
export const DRUM_INSTRUMENTS = {
  kick: { label: 'Kick', line: 8, head: 'normal', symbol: '', midi: 36, voice: 1 },
  snare: { label: 'Snare', line: 4, head: 'normal', symbol: '', midi: 38, voice: 0 },
  rimshot: { label: 'Rimshot', line: 4, head: 'diamond', symbol: 'RS', midi: 38, voice: 0 },
  sidestick: { label: 'Side stick', line: 4, head: 'x', symbol: '', midi: 37, voice: 0 },
  closedHH: { label: 'Closed hi-hat', line: -1, head: 'x', symbol: '+', midi: 42, voice: 0 },
  openHH: { label: 'Open hi-hat', line: -1, head: 'circleX', symbol: '○', midi: 46, voice: 0 },
  pedalHH: { label: 'Pedal hi-hat', line: 10, head: 'x', symbol: 'ped.', midi: 44, voice: 1 },
  highTom: { label: 'High tom', line: 2, head: 'normal', symbol: '', midi: 50, voice: 0 },
  midTom: { label: 'Mid tom', line: 3, head: 'normal', symbol: '', midi: 47, voice: 0 },
  lowTom: { label: 'Low tom', line: 6, head: 'normal', symbol: '', midi: 45, voice: 0 },
  crash: { label: 'Crash', line: -3, head: 'x', symbol: '', midi: 49, voice: 0 },
  ride: { label: 'Ride', line: 1, head: 'x', symbol: '', midi: 51, voice: 0 },
  rideBell: { label: 'Ride bell', line: 1, head: 'diamond', symbol: 'bell', midi: 53, voice: 0 },
} as const;
export type DrumInstrument = keyof typeof DRUM_INSTRUMENTS;
export type DrumMappings = Record<string, DrumInstrument | ''>;
export const drumPadKey = (sourceId: string, padId: string) => JSON.stringify([sourceId, padId]);
const GM: Record<number, DrumInstrument> = { 35:'kick',36:'kick',37:'sidestick',38:'snare',40:'snare',41:'lowTom',42:'closedHH',43:'lowTom',44:'pedalHH',45:'lowTom',46:'openHH',47:'midTom',48:'midTom',49:'crash',50:'highTom',51:'ride',53:'rideBell',57:'crash',59:'ride' };
/** MIDI is only a suggestion. Never parse padId as a pitch. */
export const suggestDrumInstrument = (pad: DrumPad): DrumInstrument | '' => GM[pad.midiPitch] ?? '';
export interface DrumNotationHit { id: string; clipId: string; occurrence: number; tick: number; padId: string; velocity: number; instrument: DrumInstrument }
export interface DrumBeat { tick: number; ticks: number; base: NotationBeat['base']; dots: NotationBeat['dots']; hits: DrumNotationHit[] }
export interface DrumScore {
  kind: 'drum'; title: string; trackName: string; startBar: number; endBar: number;
  bars: { number: number; numerator: number; denominator: number; voices: DrumBeat[][] }[];
  diagnostics: NotationDiagnostic[]; legend: DrumInstrument[];
}
export type DrumResult = { ok: true; score: DrumScore } | { ok: false; diagnostics: NotationDiagnostic[] };
export function buildDrumNotation(project: Project, opts: { trackId: string; startBar?: number; endBar?: number; mappings?: DrumMappings }): DrumResult {
  const diagnostics: NotationDiagnostic[] = [];
  const fail = (code: string, message: string): DrumResult => ({ ok:false, diagnostics:[{level:'error',code,message}] });
  const track = project.tracks.find(t => t.id === opts.trackId);
  if (!track || track.kind !== 'drum') return fail('NOT_DRUM', 'Select one drum track');
  const mm = new MeterMap(project.meterMap);
  const clips = track.clips.filter((c): c is MusicClip => c.kind === 'music');
  const tm = new TempoMap(project.tempoMap);
  const clipEnds = project.tracks.flatMap(t => t.clips.map(c => {
    if (c.kind === 'music') return c.startTick + c.durationTicks;
    const source = project.sources.find(s => s.id === c.sourceId);
    const asset = source?.kind === 'audio' ? project.assets.find(a => a.id === source.assetId) : undefined;
    const rate = asset?.audio?.sampleRate;
    if (!rate) diagnostics.push({level:'warn',code:'UNKNOWN_AUDIO_LENGTH',message:`Audio clip ${c.id}: missing sample rate; whole-song end estimated at 48000 Hz. Select an explicit bar range to override.`});
    return tm.secondsToTick(c.startSeconds + c.sourceFrameCount / (rate ?? 48000));
  }));
  const songEnd = Math.max(1, ...clipEnds);
  const startBar = opts.startBar ?? 1, endBar = opts.endBar ?? mm.tickToBarBeat(songEnd - 1).bar;
  if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || startBar < 1 || endBar < startBar || endBar-startBar >= 2000) return fail('BAD_RANGE', 'Invalid bar range (maximum 2000 bars)');
  const lo = mm.barToTick(startBar), hi = mm.barToTick(endBar+1);
  const hits: DrumNotationHit[] = [];
  for (const c of clips) {
    if (c.muted) { diagnostics.push({level:'info',code:'CLIP_MUTED',message:`Muted clip ${c.name} excluded as in playback`}); continue; }
    const src = project.sources.find(s => s.id === c.sourceId);
    if (!src || src.kind !== 'drum') { diagnostics.push({level:'error',code:'INVALID_DRUM_SOURCE',message:`Omitted clip ${c.id}: missing drum source`}); continue; }
    for (const w of clipWindows(c, src.lengthTicks)) for (const h of src.hits) {
      const tick = h.tick + w.clipStart-w.sourceStart;
      if (h.tick < w.sourceStart || h.tick >= w.sourceEnd || tick < lo || tick >= hi) continue;
      const pad = src.pads.find(p => p.id === h.padId);
      if (pad?.chokeGroup !== null && pad?.chokeGroup !== undefined && !diagnostics.some(d=>d.code==='CHOKE_PLAYBACK_ONLY')) diagnostics.push({level:'info',code:'CHOKE_PLAYBACK_ONLY',message:'Choke groups affect playback only. Open/closed HH marks identify the selected instrument, not note sustain or an explicit choke action.'});
      const key = drumPadKey(src.id,h.padId);
      const instrument = opts.mappings && Object.hasOwn(opts.mappings,key) ? opts.mappings[key] : pad ? suggestDrumInstrument(pad) : '';
      if (!instrument || !Object.hasOwn(DRUM_INSTRUMENTS,instrument)) { diagnostics.push({level:'error',code:'UNMAPPED_PAD',message:`Omitted hit ${h.id}: unmapped pad ${h.padId} (${pad?.name ?? 'missing pad'})`,bar:mm.tickToBarBeat(tick).bar,noteIds:[h.id]}); continue; }
      hits.push({...h,tick,instrument,clipId:c.id,occurrence:w.occurrence});
    }
  }
  const bars: DrumScore['bars'] = [];
  const used = new Set<DrumInstrument>();
  for (let bn=startBar; bn<=endBar; bn++) {
    const bs=mm.barToTick(bn), be=mm.barToTick(bn+1), meter=mm.meterAt(bs);
    const group=PPQ*4/meter.denominator*(meter.numerator>3 && meter.numerator%3===0 ? 3 : 1);
    const voices: DrumBeat[][] = [];
    for (let vi=0;vi<2;vi++) {
      const events=hits.filter(h=>h.tick>=bs && h.tick<be && DRUM_INSTRUMENTS[h.instrument].voice===vi);
      const bad=events.filter(h=>(h.tick-bs)%60!==0);
      for (const h of bad) diagnostics.push({level:'error',code:'UNSUPPORTED_RHYTHM',message:`Omitted hit ${h.id} at tick ${h.tick}: not on supported 1/64 grid (tuplets unsupported)`,bar:bn,noteIds:[h.id]});
      const valid=events.filter(h=>!bad.includes(h));
      const beats: DrumBeat[]=[];
      let t=bs;
      while(t<be) {
        const chord=valid.filter(h=>h.tick===t);
        const positions = new Map<number, DrumNotationHit[]>();
        for (const h of chord) { const line=DRUM_INSTRUMENTS[h.instrument].line; positions.set(line,[...(positions.get(line) ?? []),h]); }
        for (const list of positions.values()) if(list.length>1) diagnostics.push({level:'error',code:'OVERLAPPING_DRUM_HEADS',message:`${list.length} attacks share one staff position at tick ${t}; glyphs can overlap. All source events retained; inspect source before use.`,bar:bn,noteIds:list.map(h=>h.id)});
        const next=valid.filter(h=>h.tick>t).reduce((n,h)=>Math.min(n,h.tick),be);
        const boundary=Math.min(be, bs+(Math.floor((t-bs)/group)+1)*group);
        // A hit owns exactly one notated attack, at most an eighth. No sustained/tied cymbals.
        const limit=Math.min(next,boundary,t+(chord.length ? PPQ/2 : be-t));
        const parts=decomposeTicks(limit-t);
        if (!parts?.length) { diagnostics.push({level:'error',code:'UNSUPPORTED_RHYTHM',message:`Omitted voice ${vi+1} remainder at tick ${t}`,bar:bn,noteIds:valid.filter(h=>h.tick>=t).map(h=>h.id)}); break; }
        const p=parts[0];
        beats.push({...p,tick:t,hits:chord}); chord.forEach(h=>used.add(h.instrument));
        t+=p.ticks;
      }
      voices.push(beats);
    }
    bars.push({number:bn,numerator:meter.numerator,denominator:meter.denominator,voices});
  }
  return {ok:true,score:{kind:'drum',title:project.title,trackName:track.name,startBar,endBar,bars,diagnostics,legend:[...used]}};
}
