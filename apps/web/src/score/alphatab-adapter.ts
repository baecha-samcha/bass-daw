// NotationScore(@bass-daw/notation) → alphaTab 데이터 모델. 렌더 전용: 플레이어·MIDI·soundfont 는 쓰지 않는다.
// 명시적 변환:
//  - 현 순서: 원본 stringIndex 0 = 가장 낮은 현 → alphaTab Note.string 1 = 가장 낮은 현 (string = stringIndex + 1)
//  - 튜닝: 원본 tuning 은 낮은 현→높은 현 → alphaTab Tuning.tunings 는 높은 현→낮은 현 (reverse)
//  - 옥타브: 저장 음높이 = 실제(sounding). 오선보 표시는 한 옥타브 위 → Staff.displayTranspositionPitch = -12
//    (alphaTab: displayValue = realValue - displayTranspositionPitch, 렌더링에만 적용, 1.8.4 에서 실측)
import type * as AT from '@coderline/alphatab';
import type { NotationScore } from '@bass-daw/notation';

type AlphaTab = typeof AT;

export const toAlphaTabString = (stringIndex: number) => stringIndex + 1;
export const toAlphaTabTunings = (tuningLowToHigh: number[]) => [...tuningLowToHigh].reverse();

export function toAlphaTabScore(at: AlphaTab, n: NotationScore): AT.model.Score {
  const m = at.model;
  const score = new m.Score();
  score.title = n.title;
  score.subTitle = `${n.trackName} · ${n.startBar === n.endBar ? `마디 ${n.startBar}` : `마디 ${n.startBar}–${n.endBar}`}`;
  score.tab = '';
  const track = new m.Track();
  track.name = n.trackName;
  track.shortName = 'Bass';
  score.addTrack(track);
  const staff = track.staves[0] ?? (() => { const s = new m.Staff(); track.addStaff(s); return s; })();
  staff.stringTuning = new m.Tuning(`${n.stringCount}-string bass`, toAlphaTabTunings(n.tuning), false);
  staff.showTablature = n.staves !== 'score';
  staff.showStandardNotation = n.staves !== 'tab';
  staff.displayTranspositionPitch = -n.writtenOctaveShift;

  for (const b of n.bars) {
    const mb = new m.MasterBar();
    mb.timeSignatureNumerator = b.numerator;
    mb.timeSignatureDenominator = b.denominator;
    for (const t of b.tempo) {
      const a = m.Automation.buildTempoAutomation(false, t.offsetTicks / b.ticks, t.bpm, 2, true);
      mb.tempoAutomations.push(a);
    }
    score.addMasterBar(mb);
    const bar = new m.Bar();
    bar.clef = m.Clef.F4;
    bar.keySignature = n.key.fifths as AT.model.KeySignature;
    bar.keySignatureType = n.key.mode === 'minor' ? m.KeySignatureType.Minor : m.KeySignatureType.Major;
    staff.addBar(bar);
    const voice = new m.Voice();
    bar.addVoice(voice);
    for (const bt of b.beats) {
      const beat = new m.Beat();
      beat.duration = bt.base as unknown as AT.model.Duration;
      beat.dots = bt.dots;
      beat.isEmpty = false;
      if (bt.text) beat.text = bt.text;
      beat.slap = bt.notes.some((x) => x.slap);
      beat.pop = bt.notes.some((x) => x.pop);
      voice.addBeat(beat);
      for (const x of bt.notes) {
        const note = new m.Note();
        note.string = toAlphaTabString(x.stringIndex);
        note.fret = x.fret;
        note.isDead = x.dead;
        if (x.tieFromPrevious) note.isTieDestination = true;
        if (x.slideToNext) note.slideOutType = m.SlideOutType.Shift; // 재생은 목표 음을 다시 어택 → shift slide
        if (x.hammerOrPullToNext) note.isHammerPullOrigin = true;
        beat.addNote(note);
      }
    }
  }
  return score;
}

/** 렌더 설정: 플레이어 비활성, SVG, 페이지 레이아웃, 지연 로딩 없음(인쇄용) */
export function renderSettings(at: AlphaTab, n: Pick<NotationScore, 'staves' | 'startBar'>, fontDirectory: string): AT.json.SettingsJson {
  const profile = n.staves === 'tab' ? at.StaveProfile.Tab : n.staves === 'score' ? at.StaveProfile.Score : at.StaveProfile.ScoreTab;
  const elements = new Map<AT.NotationElement, boolean>();
  if (n.startBar !== 1) elements.set(at.NotationElement.BarNumber, false); // 렌더러 번호는 1부터라 범위 인쇄에서는 숨김
  elements.set(at.NotationElement.GuitarTuning, true);
  // 기보 모델에 셈여림이 없다(velocity → dynamics 변환 미지원). alphaTab 기본값 f 가 임의로 찍히지 않게 숨긴다.
  elements.set(at.NotationElement.EffectDynamics, false);
  return {
    core: { engine: 'svg', fontDirectory, useWorkers: false, enableLazyLoading: false, logLevel: at.LogLevel.Warning },
    player: { enablePlayer: false },
    display: { staveProfile: profile, layoutMode: at.LayoutMode.Page, scale: 0.9, resources: { secondaryGlyphColor: '#000000' } },
    notation: { rhythmMode: at.TabRhythmMode.ShowWithBars, elements },
  } as AT.json.SettingsJson;
}
