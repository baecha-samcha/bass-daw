// 02-project-schema.md 의 영속 계약. 이 파일이 Project 형태의 단일 소유 정의이다.
export type Id = string;
export type Tick = number;
export type Frames = number;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ResultError { code: string; path: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; errors: ResultError[] };

export const PPQ = 960 as const;

export interface TempoPoint { tick: Tick; bpm: number; transition: 'step' }
export interface MeterPoint { tick: Tick; numerator: number; denominator: 1 | 2 | 4 | 8 | 16 | 32 }

export interface Project {
  format: 'bass-daw-project'; schemaVersion: 1; id: Id;
  title: string; createdAt: string; updatedAt: string; ppq: 960;
  tempoMap: TempoPoint[]; meterMap: MeterPoint[];
  tracks: Track[]; sources: Source[]; assets: Asset[];
  channels: Channel[]; masterChannelId: Id;
  plugins: PluginInstance[]; automation: AutomationLane[];
  loop: { enabled: boolean; startTick: Tick; endTick: Tick };
  metadata: Record<string, string>;
}

export type TrackKind = 'tab' | 'midi' | 'drum' | 'audio';
export interface Track {
  id: Id; name: string; color: string; order: number;
  kind: TrackKind; channelId: Id;
  muted: boolean; solo: boolean; clips: Clip[];
  instrumentSlot: Id | null;
}

export type Clip = MusicClip | AudioClip;
export interface MusicClip {
  id: Id; kind: 'music'; sourceId: Id; name: string; muted: boolean;
  startTick: Tick; durationTicks: Tick; sourceOffsetTick: Tick;
  loopSource: boolean;
}
export interface AudioClip {
  id: Id; kind: 'audio'; sourceId: Id; name: string; muted: boolean;
  startSeconds: number; sourceStartFrame: Frames; sourceFrameCount: Frames;
  gain: number; fadeInFrames: Frames; fadeOutFrames: Frames;
}

export type Source = TabSource | MidiSource | DrumSource | AudioSource;
export interface TabSource {
  id: Id; kind: 'tab'; lengthTicks: Tick; instrument: 'bass' | 'guitar';
  tuning: number[]; maxFret: number; notes: TabNote[];
  /** MVP-3 보완(docs/decisions/0004): 코드·스트로크·아르페지오 원본. */
  strums: TabStrum[];
}
export interface TabNote {
  id: Id; tick: Tick; durationTicks: Tick; stringIndex: number;
  fret: number; velocity: number; techniques: Technique[];
}
export type Technique = { kind: 'mute' | 'slap' | 'pop' } |
  { kind: 'hammer-on' | 'pull-off' | 'slide'; targetNoteId: Id } |
  { kind: 'bend'; points: { offsetTick: Tick; semitones: number }[] };

/** 현별 운지. fret=null 이면 뮤트(x) — 발음하지 않는다. 목록에 없는 현은 연주하지 않는다. */
export interface StrumString { stringIndex: number; fret: number | null; velocity: number }
export interface TabStrum {
  id: Id; tick: Tick; durationTicks: Tick;
  chordName: string | null; // 보조 정보
  strings: StrumString[];
  direction: 'down' | 'up';
  spreadMs: number;   // 현 사이 발음 간격 0..100ms
  accent: number;     // 전체 강세 0..2 (현별 velocity 에 곱한다)
  arpeggio: null | { order: number[]; stepTicks: Tick }; // order=stringIndex 순서
}

export interface MidiSource {
  id: Id; kind: 'midi'; lengthTicks: Tick; notes: MidiNote[];
  cc: { id: Id; tick: Tick; channel: number; controller: number; value: number }[];
  pitchBend: { id: Id; tick: Tick; channel: number; value: number }[];
}
export interface MidiNote {
  id: Id; tick: Tick; durationTicks: Tick; pitch: number;
  velocity: number; channel: number;
}
export interface DrumPad { id: Id; name: string; midiPitch: number; chokeGroup: number | null }
export interface DrumHit { id: Id; tick: Tick; padId: Id; velocity: number }
export interface DrumSource {
  id: Id; kind: 'drum'; lengthTicks: Tick;
  hits: DrumHit[];
  pads: DrumPad[];
}
export interface AudioSource { id: Id; kind: 'audio'; assetId: Id }
export interface Asset {
  id: Id; sha256: string; byteLength: number; mediaType: string;
  audio: null | { sampleRate: number; channels: number; frameCount: Frames };
  license: { name: string; origin: string; redistribution: 'allowed' | 'unknown' | 'forbidden' };
}
export interface PluginInstance {
  instanceId: Id; pluginId: string; pluginVersion: string; stateVersion: number;
  role: 'instrument' | 'effect'; state: Json;
  parameters: Record<string, number>; assets: Id[];
}

export interface Send { id: Id; targetChannelId: Id; gain: number; tap: 'pre' | 'post' }
export interface Channel {
  id: Id; kind: 'track' | 'bus' | 'master'; name: string;
  gain: number; pan: number; muted: boolean; solo: boolean;
  output: Id | null; effects: Id[];
  sends: Send[];
}
export interface ParameterTarget { owner: 'channel' | 'plugin'; ownerId: Id; parameterId: string }
export interface AutomationPoint { tick: Tick; value: number; interpolation: 'step' | 'linear' }
export interface AutomationLane {
  id: Id; target: ParameterTarget; enabled: boolean;
  points: AutomationPoint[];
}
