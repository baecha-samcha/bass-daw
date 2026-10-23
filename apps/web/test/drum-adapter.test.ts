import { it,expect } from 'vitest';
import * as at from '@coderline/alphatab';
import { buildDrumNotation,DRUM_INSTRUMENTS,drumPadKey } from '@bass-daw/notation';
import { drumCheckProject } from '../src/score/drum-check-cases.ts';
import { toAlphaTabDrumScore } from '../src/score/drum-adapter.ts';
it('alphaTab 1.8.4 percussion proof: five lines, neutral clef, custom heads, 2 voices, no ties/ghost/accent',()=>{
 const p=drumCheckProject();const r=buildDrumNotation(p,{trackId:'drum-track',mappings:Object.fromEntries(Object.keys(DRUM_INSTRUMENTS).map(k=>[drumPadKey('drum-src',k),k]))}); if(!r.ok)throw Error();
 const s=toAlphaTabDrumScore(at,r.score);s.finish(new at.Settings());
 const staff=s.tracks[0].staves[0];
 expect([staff.isPercussion,staff.standardNotationLineCount,staff.showTablature,staff.showStandardNotation]).toEqual([true,5,false,true]);
 expect(staff.bars[0].clef).toBe(at.model.Clef.Neutral);
 expect(staff.bars.every(b=>b.voices.length===2)).toBe(true);
 const notes=staff.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(bt=>bt.notes)));
 expect(notes.length).toBe(r.score.bars.flatMap(b=>b.voices.flatMap(v=>v.flatMap(bt=>bt.hits))).length);
 expect(notes.every(n=>n.isPercussion&&!n.isTieDestination&&!n.isGhost)).toBe(true);
 for(const b of staff.bars) for(const [vi,v] of b.voices.entries()) expect(v.beats.every(bt=>bt.preferredBeamDirection===(vi===0?at.rendering.BeamDirection.Up:at.rendering.BeamDirection.Down))).toBe(true);
 for(const [i,key] of r.score.legend.entries()) {const d=DRUM_INSTRUMENTS[key],a=s.tracks[0].percussionArticulations[i];expect([a.staffLine,a.outputMidiNumber]).toEqual([d.line,d.midi]);expect(a.noteHeadDefault).toBe(d.head==='x'?at.model.MusicFontSymbol.NoteheadXBlack:d.head==='circleX'?at.model.MusicFontSymbol.NoteheadCircleX:d.head==='diamond'?at.model.MusicFontSymbol.NoteheadDiamondBlack:at.model.MusicFontSymbol.NoteheadBlack);}
});
