import { useApp } from '../store.ts';
import { findClip } from './Timeline.tsx';
import { TabEditor } from './TabEditor.tsx';
import { PianoRoll } from './PianoRoll.tsx';
import { DrumEditor } from './DrumEditor.tsx';
import { AudioClipEditor } from './AudioClipEditor.tsx';
import type { NoteOp } from '@bass-daw/project-core';

export function editNotes(clipId: string, ops: NoteOp[], label = 'Edit notes'): boolean {
  if (!ops.length) return true;
  return useApp.getState().run(label, { type: 'EditNotes', clipId, ops });
}

/** EditNotes 의 copy-on-write 로 clip 의 source 가 바뀔 수 있으므로 항상 최신 source 를 조회한다 */
export function useClipSource(clipId: string | null) {
  const project = useApp((s) => s.project);
  if (!project || !clipId) return null;
  const f = findClip(project, clipId);
  if (!f) return null;
  const source = project.sources.find((s) => s.id === f.clip.sourceId) ?? null;
  return { project, track: f.track, clip: f.clip, source };
}

export function ClipEditor({ tick }: { tick: number }) {
  const sel = useApp((s) => s.selection);
  const ctx = useClipSource(sel.clipId);
  if (!ctx?.source) return <div className="dim">타임라인에서 클립을 선택하면 해당 악기의 편집기가 열립니다. 트랙을 추가하면 8마디 빈 클립이 함께 생성됩니다.</div>;
  const { clip, source } = ctx;
  if (clip.kind === 'audio') return <AudioClipEditor clipId={clip.id} tick={tick} />;
  if (source.kind === 'tab') return <TabEditor clipId={clip.id} tick={tick} />;
  if (source.kind === 'midi') return <PianoRoll clipId={clip.id} tick={tick} />;
  if (source.kind === 'drum') return <DrumEditor clipId={clip.id} tick={tick} />;
  return null;
}

/** 편집기 공통: source 기준 tick → 화면 x (클립 offset 을 반영해 곡 위치를 보조 표시) */
export const NOTE_LENGTHS: [number, string][] = [[3840, '온음표'], [1920, '2분'], [960, '4분'], [480, '8분'], [240, '16분'], [120, '32분'], [320, '8분 셋잇단']];

export function EditorBar({ children }: { children: React.ReactNode }) {
  return <div className="row" style={{ marginBottom: 6 }} role="toolbar">{children}</div>;
}
