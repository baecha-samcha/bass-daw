// 01 §3 Performance Event 계약 (+ docs/decisions/0004: timeOffsetSeconds, padId).
import type { Tick, Id } from '@bass-daw/schemas';

export interface EventBase {
  tick: Tick; trackId: Id; clipId: Id; sourceId: Id;
  occurrence: number;
  /** Tick 이후의 sub-tick 시간차(스트로크 현 간격). frame = round((seconds(tick)+offset)*sr) */
  timeOffsetSeconds: number;
  /** 동종 이벤트 안정 정렬용 source event ID */
  sourceEventId: string;
}
export type PerformanceEvent = EventBase & (
  | { kind: 'noteOn'; voiceKey: string; pitch: number; velocity: number; channel: number; articulation: string; stringIndex: number | null; padId: Id | null }
  | { kind: 'noteOff'; voiceKey: string }
  | { kind: 'cc'; channel: number; controller: number; value: number }
  | { kind: 'pitchBend'; channel: number; value: number }
  | { kind: 'expression'; voiceKey: string; parameterId: string; value: number }
);
export type PerformanceEventKind = PerformanceEvent['kind'];

/** 동일 frame 순서: reset/종료 → noteOff → CC/pitch/expression → noteOn */
export const KIND_PRIORITY: Record<PerformanceEventKind | 'reset', number> = {
  reset: 0, noteOff: 1, cc: 2, pitchBend: 2, expression: 2, noteOn: 3,
};

/** source-local 이벤트(어댑터 출력). clip 전개 전 단계. */
export type SourceEvent =
  | { kind: 'note'; id: string; tick: Tick; durationTicks: Tick; pitch: number; velocity: number; channel: number; articulation: string; stringIndex: number | null; padId: Id | null; timeOffsetSeconds: number; expressions: { offsetTick: Tick; parameterId: string; value: number }[] }
  | { kind: 'cc'; id: string; tick: Tick; channel: number; controller: number; value: number }
  | { kind: 'pitchBend'; id: string; tick: Tick; channel: number; value: number };

export interface CompileDiagnostic { code: string; sourceId: Id; eventId?: string; message: string }
export interface SourceCompileResult { events: SourceEvent[]; diagnostics: CompileDiagnostic[] }
