import { describe,it,expect } from 'vitest';
import { buildDrumNotation, drumPadKey, DRUM_INSTRUMENTS, type DrumScore } from '../src/index.ts';
import { drumCheckProject, drumCheckCases } from '../../../apps/web/src/score/drum-check-cases.ts';
import type { DrumSource } from '@bass-daw/schemas';
import { createHash } from 'node:crypto';
import { compilePlan } from '@bass-daw/audio-engine';
const buildPlaybackPlan=(p: Parameters<typeof compilePlan>[0])=>compilePlan(p,{sampleRate:48000,profile:'balanced'});
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function score(p=drumCheckProject(),opts={}) {const r=buildDrumNotation(p,{trackId:'drum-track',...opts});if(!r.ok) throw Error(JSON.stringify(r));return r.score;}
const allHits=(s:DrumScore)=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.flatMap(bt=>bt.hits)));
describe('drum notation',()=>{
 it('keeps every hit, simultaneous kick/snare/HH and raw velocities without inferred expression',()=>{
  const p=drumCheckProject(), src=p.sources[0] as DrumSource;
  const r=score(p,{mappings:Object.fromEntries(Object.keys(DRUM_INSTRUMENTS).map(k=>[drumPadKey(src.id,k),k]))});
  expect(allHits(r).map(h=>h.id).sort()).toEqual(src.hits.map(h=>h.id).sort());
  expect(allHits(r).map(h=>[h.id,h.velocity]).sort()).toEqual(src.hits.map(h=>[h.id,h.velocity]).sort());
  expect(allHits(r).filter(h=>h.tick===0).map(h=>h.instrument).sort()).toEqual(['closedHH','kick','snare']);
  for(const b of r.bars) for(const [vi,v] of b.voices.entries()) for(const bt of v) {
   expect(bt.ticks).toBeLessThanOrEqual(bt.hits.length?480:3840);
   for(const h of bt.hits) expect(DRUM_INSTRUMENTS[h.instrument].voice).toBe(vi);
  }
 });
 it('fills both voices exactly, with beat-boundary splits and empty bars',()=>{
  const p=drumCheckProject(); (p.sources[0] as DrumSource).hits=[];
  p.meterMap=[{tick:0,numerator:4,denominator:4},{tick:3840,numerator:3,denominator:4}];
  const r=score(p,{endBar:3});
  expect(r.bars.map(b=>b.voices.map(v=>v.reduce((n,bt)=>n+bt.ticks,0)))).toEqual([[3840,3840],[2880,2880],[2880,2880]]);
  expect(allHits(r)).toEqual([]);
 });
 it('uses pad identities, never interprets numeric custom IDs as pitch, diagnoses missing/unknown and tuplets',()=>{
  const c=drumCheckCases()[1],r=score(c.project,c.options);
  expect(allHits(r).find(h=>h.id==='custom-hit')?.instrument).toBe('rimshot');
  expect(r.diagnostics.filter(d=>d.code==='UNMAPPED_PAD').flatMap(d=>d.noteIds)).toEqual(['unknown-hit']);
  expect(r.diagnostics.filter(d=>d.code==='UNSUPPORTED_RHYTHM').flatMap(d=>d.noteIds)).toEqual(['tuplet']);
  expect(allHits(r).some(h=>h.id==='unknown-hit'||h.id==='tuplet')).toBe(false);
  expect(score(c.project,{mappings:{[drumPadKey('drum-src','snare')]:''}}).diagnostics.some(d=>d.code==='UNMAPPED_PAD')).toBe(true);
 });
 it('clip placement + source trim + loops + range have independently calculated attacks',()=>{
  const p=drumCheckProject(); const src=p.sources[0] as DrumSource;
  src.lengthTicks=1920;src.hits=[{id:'a',tick:0,padId:'kick',velocity:10},{id:'b',tick:480,padId:'snare',velocity:20},{id:'c',tick:1440,padId:'closedHH',velocity:30}];
  const c=p.tracks[0].clips[0];if(c.kind!=='music')throw Error();
  Object.assign(c,{startTick:960,sourceOffsetTick:480,durationTicks:6000,loopSource:true});
  const r=score(p,{startBar:2,endBar:2});
  // windows: b960 c1920; a2400 b2880 c3840; a4320 b4800 c5760; a6240 b6720
  expect(allHits(r).map(h=>[h.id,h.tick]).sort((a,b)=>Number(a[1])-Number(b[1]))).toEqual([['c',3840],['a',4320],['b',4800],['c',5760],['a',6240],['b',6720]]);
 });
 it('same-pad overlapping clips keep multiplicity',()=>{
  const p=drumCheckProject();p.tracks[0].clips.push({...p.tracks[0].clips[0],id:'duplicate'});
  expect(allHits(score(p)).length).toBe((p.sources[0] as DrumSource).hits.length*2);
 });
 it('does not mutate project or playback plan, including choke and velocity',()=>{
  const p=drumCheckProject(),before=hash(p),play=hash(buildPlaybackPlan(p));
  score(p); score(p,{startBar:2,endBar:3,mappings:{[drumPadKey('drum-src','kick')]:'crash'}});
  expect(hash(p)).toBe(before);expect(hash(buildPlaybackPlan(p))).toBe(play);
 });
});
it('muted clips, missing pads and invalid track/range cannot silently export normally',()=>{
 const p=drumCheckProject();p.tracks[0].clips[0].muted=true;
 const s=score(p);expect(allHits(s)).toEqual([]);expect(s.diagnostics.some(d=>d.code==='CLIP_MUTED')).toBe(true);
 p.tracks[0].clips[0].muted=false;(p.sources[0] as DrumSource).hits=[{id:'missing',tick:0,padId:'absent',velocity:99}];
 expect(score(p).diagnostics).toContainEqual(expect.objectContaining({code:'UNMAPPED_PAD',noteIds:['missing']}));
 expect(buildDrumNotation(p,{trackId:'absent'}).ok).toBe(false);
 expect(buildDrumNotation(p,{trackId:'drum-track',startBar:4,endBar:2}).ok).toBe(false);
});
it('overlapping heads are reported while all hits survive in the model',()=>{
 const p=drumCheckProject();const src=p.sources[0] as DrumSource;
 src.hits=[{id:'one',tick:0,padId:'snare',velocity:1},{id:'two',tick:0,padId:'snare',velocity:127}];
 const s=score(p);expect(allHits(s).map(h=>h.id)).toEqual(['one','two']);expect(s.diagnostics).toContainEqual(expect.objectContaining({code:'OVERLAPPING_DRUM_HEADS',noteIds:['one','two']}));
});
