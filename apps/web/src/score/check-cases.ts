// 악보 출력 검증 화면(#/score-check)용 고정 사례. 원본 모델(Project)로 만들고 같은 변환 경로를 거친다.
import { createEmptyProject, type Project, type Technique, type TabNote } from '@bass-daw/schemas';
import type { NotationOptions } from '@bass-daw/notation';

type N = [tick: number, dur: number, string: number, fret: number, tech?: Technique[], id?: string];
const Q = 960, E = 480, S = 240, H = 1920, W = 3840;

function project(title: string, tuning: number[], notes: N[], extra: Partial<Project> = {}, clip: Record<string, unknown> = {}): Project {
  const p = createEmptyProject({ id: `check-${title}`, title, now: '2026-10-23T00:00:00.000Z', masterId: 'm' });
  Object.assign(p, extra);
  p.channels.push({ id: 'c', kind: 'track', name: 'Bass', gain: 1, pan: 0, muted: false, solo: false, output: 'm', effects: [], sends: [] });
  const ns: TabNote[] = notes.map(([tick, durationTicks, stringIndex, fret, techniques = [], id], i) => ({ id: id ?? `n${i}`, tick, durationTicks, stringIndex, fret, velocity: 100, techniques }));
  const len = Math.max(W, ...notes.map((n) => n[0] + n[1]));
  const lengthTicks = Math.ceil(len / W) * W;
  p.sources.push({ id: 's', kind: 'tab', lengthTicks, instrument: 'bass', tuning, maxFret: 24, notes: ns, strums: [] });
  p.tracks.push({ id: 't', name: 'Bass', color: '#e07a5f', order: 0, kind: 'tab', channelId: 'c', muted: false, solo: false, instrumentSlot: null,
    clips: [{ id: 'k', kind: 'music', sourceId: 's', name: 'Clip', muted: false, startTick: 0, durationTicks: lengthTicks, sourceOffsetTick: 0, loopSource: false, ...clip }] });
  return p;
}

export interface CheckCase { id: string; title: string; expect: string; project: Project; options: NotationOptions }

export function checkCases(): CheckCase[] {
  const rhythm: N[] = [
    [0, Q, 0, 0], [Q, E, 0, 3], [Q + E, E, 0, 5], [H, Q + E, 1, 2], [H + Q + E, E, 1, 4], // 4·8·점4
    [W, S, 2, 2], [W + S, S, 2, 4], [W + E, Q, 2, 5], [W + H, H + Q, 3, 2],               // 16분, 마디 넘김 붙임줄
    [2 * W + 2 * Q, Q, 0, 7],                                                                  // 3/4 마디, 쉼표
  ];
  const long: N[] = Array.from({ length: 120 * 4 }, (_, i) => [i * Q, Q, i % 4, (i * 3) % 12] as N).filter((_, i) => i % 5 !== 4); // 5박마다 쉼표
  return [
    { id: 'four-both', title: '4현 표준 · TAB+오선 · 음표/쉼표/붙임줄/박자/템포', expect: '4·8·점4·16분, 마디2→3 붙임줄, 3/4 마디, 템포 100→132(마디2 중간)',
      project: project('Rhythm', [28, 33, 38, 43], rhythm, { tempoMap: [{ tick: 0, bpm: 100, transition: 'step' }, { tick: W + H, bpm: 132, transition: 'step' }], meterMap: [{ tick: 0, numerator: 4, denominator: 4 }, { tick: 2 * W, numerator: 3, denominator: 4 }] }),
      options: { trackId: 't', staves: 'both' } },
    { id: 'five-tab', title: '5현(B E A D G) · TAB 만', expect: '가장 낮은 줄(5번 현, B0) 개방 = TAB 맨 아래 줄 0',
      project: project('Five', [23, 28, 33, 38, 43], [[0, Q, 0, 0], [Q, Q, 1, 2], [H, Q, 4, 5], [3 * Q, Q, 0, 5]]), options: { trackId: 't', staves: 'tab' } },
    { id: 'six-score', title: '6현(B E A D G C) · 오선 만', expect: '높은 C 현 개방(C3 실음) → 오선 C4 (가운데 C, 한 옥타브 위 표기)',
      project: project('Six', [23, 28, 33, 38, 43, 48], [[0, Q, 5, 0], [Q, Q, 0, 0], [H, H, 3, 0]]), options: { trackId: 't', staves: 'score' } },
    { id: 'dropd-key', title: '사용자 튜닝 Drop D(D A D G) · 조표 D major', expect: '4번 현 개방 = D1 실음 → 오선 D2, 조표 #2',
      project: project('DropD', [26, 33, 38, 43], [[0, Q, 0, 0], [Q, Q, 0, 4], [H, Q, 1, 4], [3 * Q, Q, 2, 4]]), options: { trackId: 't', staves: 'both', key: { fifths: 2, mode: 'major' } } },
    { id: 'tech', title: '주법: 슬랩·팝·슬라이드·해머온·데드노트', expect: 'S / P 표기, 슬라이드 선(2→4), H 호, x',
      project: project('Tech', [28, 33, 38, 43], [[0, Q, 0, 5, [{ kind: 'slap' }]], [Q, Q, 2, 7, [{ kind: 'pop' }]], [H, Q, 1, 2, [{ kind: 'slide', targetNoteId: 'sl' }]], [3 * Q, Q, 1, 4, [], 'sl'],
        [W, Q, 0, 3, [{ kind: 'hammer-on', targetNoteId: 'hm' }]], [W + Q, Q, 0, 5, [], 'hm'], [W + H, Q, 1, 0, [{ kind: 'mute' }]], [W + 3 * Q, Q, 0, 0, [{ kind: 'slap' }]]]),
      options: { trackId: 't', staves: 'both' } },
    { id: 'unsupported', title: '지원하지 않는 내용 → 진단', expect: '마디1 셋잇단 → 오류 진단 + 빈 마디 경고 문구, 마디2 겹치는 성부 → 경고',
      project: project('Unsupported', [28, 33, 38, 43], [[0, 320, 0, 0], [320, 320, 0, 2], [640, 320, 0, 3], [W, H, 0, 0], [W + Q, Q, 1, 2]]), options: { trackId: 't', staves: 'both' } },
    { id: 'long', title: '120마디 · 여러 페이지 인쇄', expect: 'A4 3쪽 이상, 줄(system)이 페이지 경계에서 잘리지 않음',
      project: project('Long song', [28, 33, 38, 43], long), options: { trackId: 't', staves: 'both' } },
  ];
}
