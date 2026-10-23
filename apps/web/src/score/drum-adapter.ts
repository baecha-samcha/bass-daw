import type * as AT from '@coderline/alphatab';
import { DRUM_INSTRUMENTS, type DrumScore } from '@bass-daw/notation';
export function toAlphaTabDrumScore(at: typeof AT, n: DrumScore): AT.model.Score {
  const m=at.model, score=new m.Score(), track=new m.Track(), staff=new m.Staff();
  score.title=n.title; score.subTitle=`${n.trackName} · 마디 ${n.startBar}–${n.endBar}`;
  score.addTrack(track); track.name=n.trackName; track.shortName='Drums'; track.addStaff(staff);
  staff.isPercussion=true; staff.standardNotationLineCount=5; staff.showTablature=false; staff.showStandardNotation=true;
  track.playbackInfo.primaryChannel=9;
  const f=at.model.MusicFontSymbol;
  for (const key of n.legend) {
    const d=DRUM_INSTRUMENTS[key];
    const head=d.head==='x' ? f.NoteheadXBlack : d.head==='circleX' ? f.NoteheadCircleX : d.head==='diamond' ? f.NoteheadDiamondBlack : f.NoteheadBlack;
    track.percussionArticulations.push(new m.InstrumentArticulation(d.label,d.line,d.midi,head,head,head));
  }
  for (const b of n.bars) {
    const mb=new m.MasterBar(); mb.timeSignatureNumerator=b.numerator; mb.timeSignatureDenominator=b.denominator; score.addMasterBar(mb);
    const bar=new m.Bar(); bar.clef=m.Clef.Neutral; staff.addBar(bar);
    b.voices.forEach((beats,vi)=>{
      const v=new m.Voice(); bar.addVoice(v);
      for(const bt of beats) {
        const beat=new m.Beat(); beat.duration=bt.base as unknown as AT.model.Duration; beat.dots=bt.dots; beat.isEmpty=false;
        beat.preferredBeamDirection=vi===0 ? at.rendering.BeamDirection.Up : at.rendering.BeamDirection.Down;
        const symbols=[...new Set(bt.hits.map(h=>DRUM_INSTRUMENTS[h.instrument].symbol).filter(s=>s && s!=='○'))];
        if(symbols.length) beat.text=symbols.join(' / ');
        v.addBeat(beat);
        for(const h of bt.hits) { const note=new m.Note(); note.percussionArticulation=n.legend.indexOf(h.instrument); beat.addNote(note); }
      }
    });
  }
  return score;
}
