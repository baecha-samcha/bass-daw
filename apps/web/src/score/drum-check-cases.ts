import { createEmptyProject, createChannel, type Project, type DrumSource } from '@bass-daw/schemas';
import { DRUM_INSTRUMENTS, drumPadKey, type DrumMappings, type DrumInstrument } from '@bass-daw/notation';
export function drumCheckProject(bars=4): Project {
  const p=createEmptyProject({id:'drum-check',title:`Drums ${bars}`,now:'2026-10-23T00:00:00Z',masterId:'master'});
  const ch={...createChannel('track','Drums','master'),id:'drum-ch'}; p.channels.push(ch);
  const src: DrumSource={id:'drum-src',kind:'drum',lengthTicks:3840*bars,pads:Object.entries(DRUM_INSTRUMENTS).map(([id,d])=>({id,name:d.label,midiPitch:d.midi,chokeGroup:id.endsWith('HH')?1:null})),hits:[]};
  let id=0;
  for(let bar=0;bar<bars;bar++) {
    for(let i=0;i<8;i++) src.hits.push({id:`h${id++}`,tick:bar*3840+i*480,padId:'closedHH',velocity:30+i*12});
    for(const i of [0,2,4,6]) src.hits.push({id:`h${id++}`,tick:bar*3840+i*480,padId:i%4===0?'kick':'snare',velocity:110});
  }
  // Deliberate three-way simultaneous strike and every articulation in the short case.
  src.hits.push({id:`h${id++}`,tick:0,padId:'snare',velocity:1});
  if(bars===4) src.hits=src.hits.filter(h=>h.tick<3840 || h.tick>=11520);
  if(bars===4) Object.keys(DRUM_INSTRUMENTS).forEach((padId,i)=>src.hits.push({id:`h${id++}`,tick:3840+i*240,padId,velocity:127-i}));
  p.sources.push(src);
  p.tracks.push({id:'drum-track',name:'Drums',color:'#aaa',order:0,kind:'drum',channelId:ch.id,muted:false,solo:false,instrumentSlot:null,clips:[{id:'drum-clip',kind:'music',sourceId:src.id,name:'Drum clip',startTick:0,durationTicks:3840*bars,sourceOffsetTick:0,loopSource:false,muted:false}]});
  return p;
}
export function drumCheckCases() {
  const short=drumCheckProject();
  const custom=drumCheckProject(); const s=custom.sources[0] as DrumSource;
  s.pads.push({id:'custom-38',name:'Custom mapped',midiPitch:99,chokeGroup:null},{id:'36',name:'Unknown',midiPitch:99,chokeGroup:null});
  s.hits.push({id:'custom-hit',tick:120,padId:'custom-38',velocity:17},{id:'unknown-hit',tick:240,padId:'36',velocity:120},{id:'tuplet',tick:320,padId:'snare',velocity:50});
  const mappings: DrumMappings = Object.fromEntries(Object.keys(DRUM_INSTRUMENTS).map(k=>[drumPadKey(s.id,k),k as DrumInstrument])); mappings[drumPadKey(s.id,'custom-38')]='rimshot';
  const meter=drumCheckProject(); const ms=meter.sources[0] as DrumSource; ms.hits=ms.hits.filter(h=>h.tick<3840);
  meter.meterMap=[{tick:0,numerator:4,denominator:4},{tick:3840,numerator:6,denominator:8}];
  const c=meter.tracks[0].clips[0]; if(c.kind==='music') {c.sourceOffsetTick=480;c.loopSource=true;c.durationTicks=3840*4;ms.lengthTicks=3840;}
  return [{id:'drum-short',project:short,options:{trackId:'drum-track',mappings:Object.fromEntries(Object.keys(DRUM_INSTRUMENTS).map(k=>[drumPadKey('drum-src',k),k as DrumInstrument]))}},{id:'drum-custom',project:custom,options:{trackId:'drum-track',mappings}},{id:'drum-meter',project:meter,options:{trackId:'drum-track',startBar:2,endBar:4}},{id:'drum-long',project:drumCheckProject(120),options:{trackId:'drum-track'}}];
}
