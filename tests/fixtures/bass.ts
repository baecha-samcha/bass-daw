// 베이스 악보 출력 테스트용 프로젝트 빌더(고정 ID). 노트는 [tick, dur, stringIndex, fret, techniques?] 로 준다.
import { createEmptyProject, createChannel, type Project, type TabNote, type Technique, type MusicClip } from '@bass-daw/schemas';

export type N = [tick: number, dur: number, string: number, fret: number, tech?: Technique[], id?: string];
export function bassProject(opts: { tuning?: number[]; notes?: N[]; sourceLength?: number; clips?: Partial<MusicClip>[]; instrument?: 'bass' | 'guitar'; tempo?: Project['tempoMap']; meter?: Project['meterMap'] } = {}): Project {
  const p = createEmptyProject({ id: 'proj-bass', title: 'Bass Song', now: '2026-10-23T00:00:00.000Z', masterId: 'master' });
  if (opts.tempo) p.tempoMap = opts.tempo;
  if (opts.meter) p.meterMap = opts.meter;
  const ch = { ...createChannel('track', 'Bass', 'master'), id: 'ch-bass' };
  p.channels.push(ch);
  const notes: TabNote[] = (opts.notes ?? []).map(([tick, durationTicks, stringIndex, fret, techniques = [], id], i) => ({ id: id ?? `n${i}`, tick, durationTicks, stringIndex, fret, velocity: 100, techniques }));
  p.sources.push({ id: 'src-bass', kind: 'tab', lengthTicks: opts.sourceLength ?? 3840 * 4, instrument: opts.instrument ?? 'bass', tuning: opts.tuning ?? [28, 33, 38, 43], maxFret: 24, notes, strums: [] });
  const clips = (opts.clips ?? [{}]).map((c, i) => ({ id: `clip${i}`, kind: 'music' as const, sourceId: 'src-bass', name: `Clip ${i}`, muted: false, startTick: 0, durationTicks: opts.sourceLength ?? 3840 * 4, sourceOffsetTick: 0, loopSource: false, ...c }));
  p.tracks.push({ id: 'trk-bass', name: 'Bass', color: '#e07a5f', order: 0, kind: 'tab', channelId: ch.id, muted: false, solo: false, clips, instrumentSlot: null });
  return p;
}
