# 02 — 프로젝트 데이터 명세

버전 2.0-review · 2026-10-22 · 제안 계약, 구현 승인 전

## 1. 목적·책임·범위

프로젝트의 음악 원본, 비파괴 클립, 라우팅, 자동화 및 직렬화 불변조건을 정의한다. UI 선택 상태, 오디오 버퍼, 재생 커서, 로그인·로컬 경로는 저장하지 않는다. 기존 v1.1-draft를 대체 검토하는 별도 문서이며 source/clip 분리는 D01 승인이 필요하다. 타입은 실행 구현이 아닌 shape 계약이다. 아래 코드 블록은 같은 명세 네임스페이스로 읽는다.

## 2. 공통 타입과 프로젝트

```ts
type Id = string; // UUID, 전역 객체 ID 중복 금지
type Tick = number; // 0 이상의 safe integer; PPQ=960
type Frames = number; // 0 이상의 safe integer, 해당 sampleRate 기준
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Result<T> = { ok: true; value: T } |
  { ok: false; errors: { code: string; path: string; message: string }[] };
interface TempoPoint { tick: Tick; bpm: number; transition: 'step' }
interface MeterPoint { tick: Tick; numerator: number; denominator: 1|2|4|8|16|32 }
interface Project {
  format: 'bass-daw-project'; schemaVersion: 1; id: Id;
  title: string; createdAt: string; updatedAt: string; ppq: 960;
  tempoMap: TempoPoint[]; meterMap: MeterPoint[];
  tracks: Track[]; sources: Source[]; assets: Asset[];
  channels: Channel[]; masterChannelId: Id;
  plugins: PluginInstance[]; automation: AutomationLane[];
  loop: { enabled: boolean; startTick: Tick; endTick: Tick };
  metadata: Record<string,string>;
}
interface Track {
  id: Id; name: string; color: string; order: number;
  kind: 'tab'|'midi'|'drum'|'audio'; channelId: Id;
  muted: boolean; solo: boolean; clips: Clip[];
  instrumentSlot: Id | null; // plugins.instanceId, audio track에서는 null
}
type Clip = MusicClip | AudioClip;
interface MusicClip {
  id: Id; kind: 'music'; sourceId: Id; name: string; muted: boolean;
  startTick: Tick; durationTicks: Tick; sourceOffsetTick: Tick;
  loopSource: boolean; // source 전체 lengthTicks로 wrap
}
interface AudioClip {
  id: Id; kind: 'audio'; sourceId: Id; name: string; muted: boolean;
  startSeconds: number; sourceStartFrame: Frames; sourceFrameCount: Frames;
  gain: number; fadeInFrames: Frames; fadeOutFrames: Frames;
}
```

모든 구간은 [start,end)이다. durationTicks와 sourceFrameCount는 1 이상이다. MusicClip은 source의 불변 snapshot을 참조한다. 같은 source를 공유한 클립을 편집하면 기본 동작은 새 ID의 source를 만든 뒤 해당 클립만 재연결한다. 연결 편집은 후속 기능이다. 사용하지 않는 source/asset도 Undo·snapshot이 참조하면 삭제하지 않는다.

오디오 클립은 초 앵커, 원본 sampleRate 프레임 길이로 고정한다. 표시 위치는 현재 tempoMap의 secondsToTick으로 계산하며 정수 반올림은 표시·snap에만 적용한다. 템포 변경으로 원본 재생 속도·길이·시작 초가 바뀌지 않는다. 마디에 snap한 오디오도 저장 시 초로 확정한다. musical audio anchor와 time-stretch는 v1 제외이다. 음악 클립 복제는 Tick, 오디오 복제는 초 이동을 사용한다. 혼합 선택 이동은 UI 이동량을 초로 변환하여 오디오에 적용하고 음악은 Tick으로 양자화한다. 손실을 preview 후 원자적으로 확정한다.

## 3. 독립 Source 모델

```ts
type Source = TabSource | MidiSource | DrumSource | AudioSource;
interface TabSource {
  id: Id; kind: 'tab'; lengthTicks: Tick; instrument: 'bass'|'guitar';
  tuning: number[]; maxFret: number; notes: TabNote[];
}
interface TabNote {
  id: Id; tick: Tick; durationTicks: Tick; stringIndex: number;
  fret: number; velocity: number; techniques: Technique[];
}
type Technique = { kind: 'mute'|'slap'|'pop' } |
  { kind: 'hammer-on'|'pull-off'|'slide'; targetNoteId: Id } |
  { kind: 'bend'; points: { offsetTick: Tick; semitones: number }[] };
interface MidiSource {
  id: Id; kind: 'midi'; lengthTicks: Tick; notes: MidiNote[];
  cc: { id: Id; tick: Tick; channel: number; controller: number; value: number }[];
  pitchBend: { id: Id; tick: Tick; channel: number; value: number }[];
}
interface MidiNote {
  id: Id; tick: Tick; durationTicks: Tick; pitch: number;
  velocity: number; channel: number;
}
interface DrumSource {
  id: Id; kind: 'drum'; lengthTicks: Tick;
  hits: { id: Id; tick: Tick; padId: Id; velocity: number }[];
  pads: { id: Id; name: string; midiPitch: number; chokeGroup: number|null }[];
}
interface AudioSource { id: Id; kind: 'audio'; assetId: Id }
interface Asset {
  id: Id; sha256: string; byteLength: number; mediaType: string;
  audio: null | { sampleRate: number; channels: number; frameCount: Frames };
  license: { name: string; origin: string; redistribution: 'allowed'|'unknown'|'forbidden' };
}
interface PluginInstance {
  instanceId: Id; pluginId: string; pluginVersion: string; stateVersion: number;
  role: 'instrument'|'effect'; state: Json;
  parameters: Record<string,number>; assets: Id[];
}
```

빈 techniques 배열은 일반 주법이다. tuning은 낮은 현에서 높은 현 순서의 MIDI pitch, bass 4–6현/guitar 6–7현, fret 0..maxFret(1..36)이다. 동음이현은 서로 다른 노트로 보존한다. fret+tuning은 0..127이다. 현별 겹침은 금지하고 경계 접촉은 허용한다. 주법 링크는 같은 현·같은 source의 다음 노트를 향하며 시간 순환·자기참조를 금지한다. hammer-on은 목표 fret 증가, pull-off는 감소, slide는 다른 fret이어야 한다. 링크 주법은 한 노트당 1개, 연결 시 target.tick=note.tick+durationTicks이다. bend offset은 0에서 시작하여 durationTicks 이하, 엄격 증가, semitones -12..12이다. 지원하지 않는 주법은 원본을 보존하고 렌더링 진단을 반환한다.

MIDI pitch/controller/value는 0..127, velocity는 1..127, channel은 0..15, pitchBend는 -8192..8191이다. note-off는 duration으로 표현한다. drum pad 음원 매핑은 instrument 플러그인 state의 padId→assetId 매핑이며 03 계약을 따른다. MIDI 프로그램 변경·SysEx·MPE는 v1 제외이며 가져오기 손실 보고 대상이다.

## 4. 믹서·자동화

```ts
interface Channel {
  id: Id; kind: 'track'|'bus'|'master'; name: string;
  gain: number; pan: number; muted: boolean; solo: boolean;
  output: Id|null; effects: Id[];
  sends: { id: Id; targetChannelId: Id; gain: number; tap: 'pre'|'post' }[];
}
interface ParameterTarget {
  owner: 'channel'|'plugin'; ownerId: Id; parameterId: string;
}
interface AutomationLane {
  id: Id; target: ParameterTarget; enabled: boolean;
  points: { tick: Tick; value: number; interpolation: 'step'|'linear' }[];
}
```

채널 gain/send gain은 선형 0..4, pan -1..1이다. master만 output=null, 나머지는 master로 도달해야 한다. main output과 sends를 합친 방향 그래프는 DAG이며 feedback 금지이다. 각 track은 서로 다른 track 채널 1개, bus는 채널로만 존재한다. instrumentSlot은 instrument 역할 인스턴스, effects는 effect 역할 인스턴스만 참조한다. 플러그인 인스턴스는 한 슬롯만 점유한다. 미설치 플러그인도 참조와 상태는 보존한다.

자동화 채널 ID는 gain/pan, 플러그인은 03의 안정적인 parameterId를 사용한다. lane당 target은 유일하다. points는 tick 엄격 증가, 값은 파라미터 범위, 첫 점 이전에는 저장된 기본 parameter 값을 사용한다. 점 사이에는 왼쪽 점의 interpolation을 적용하고 마지막 값은 유지한다. v1은 read/off 동작만 지원하며 touch/latch/write 녹화는 제외이다. 수동 조작은 lane이 활성일 때 일시 preview만 하고 영속 값 수정은 명시적으로 lane 비활성 또는 점 편집으로 수행한다.

## 5. 공개 API·명령 상태 전이

```ts
interface EditCommand {
  id: Id; expectedEditSequence: number; label: string;
  changes: Json; // 등록된 typed command payload, 임의 patch 실행 금지
}
interface EditReceipt { editSequence: number; changedIds: Id[]; diagnostics: string[] }
interface ProjectService {
  validate(input: unknown): Result<Project>;
  serialize(project: Project): Result<Uint8Array>;
  deserialize(bytes: Uint8Array): Result<Project>;
  execute(command: EditCommand): Result<EditReceipt>;
  undo(): Result<EditReceipt>; redo(): Result<EditReceipt>;
}
```

명령 레지스트리 필수 항목: Create/DeleteTrack, Create/ReplaceSource, Place/Move/Trim/Split/Duplicate/DeleteClip, EditNotes, SetTempoMap, SetRouting, SetParameter, EditAutomation. 명령마다 before/after 불변 snapshot으로 역연산을 정의한다. 복합 편집은 전체 성공 또는 전체 실패이다. stale editSequence는 STALE_EDIT로 거절한다. undo 후 새 편집은 redo 분기를 해제하되 저장 snapshot은 삭제하지 않는다. 최소 100개 명령 또는 64MiB 중 먼저 도달한 한도까지 세션 Undo를 유지하며 축소를 UI에 표시한다. 재시작 후 세션 Undo 복원은 v1 제외, 저장 revision 복구는 04 책임이다.

split music: 좌측 길이=split-start, 우측 sourceOffset=(기존 offset+좌측 길이), loop일 때 modulo source.lengthTicks. split audio: split 초를 원본 프레임으로 round하여 두 선택 구간으로 나눈다. 두 조각의 합은 원래 프레임 구간과 같아야 한다. 소스 노트는 수정하지 않는다. trim은 sourceOffset/selection과 길이만 바꾼다. 클립 밖에서 시작한 음악 노트는 기본 retrigger하지 않고 선택 구간 안에서 시작한 노트만 emit, 끝은 클립 경계에서 truncate한다. 원본 노트는 보존한다.

## 6. 불변조건·직렬화·마이그레이션

모든 number는 finite이며 integer 제약과 합산 overflow까지 검사한다. 날짜는 UTC ISO 문자열, updatedAt>=createdAt, read-only round trip은 날짜를 바꾸지 않는다. tempo/meter는 tick 0 필수, 중복 없는 오름차순, bpm 20..400, numerator 1..32이다. meter 변경은 이전 meter의 마디 경계에서만 허용한다. 시작 마디는 1, 첫 Tick은 0이다. source.lengthTicks는 양수이며 모든 노트의 끝/CC/hit가 경계를 넘지 않는다. nonloop clip의 offset+duration<=source.lengthTicks, loop clip offset<source.lengthTicks이다. loop.endTick>startTick이다. track kind와 source kind는 일치한다.

오디오 asset은 원본 파일 바이트 SHA-256(소문자 64 hex)로 식별하고 audio 메타데이터는 디코딩 결과다. sampleRate 8k..192k, mono/stereo만 v1에서 허용한다. 선택 범위는 frameCount 안, fades 합은 sourceFrameCount 이하이다. decode 불가 시 원본을 삭제하지 않는다. ID와 자산 참조가 올바르지만 바이트가 없는 경우 구조 오류가 아닌 degraded project로 연다.

UTF-8 JSON의 key는 사전순, 배열 순서는 보존한다. -0은 0, 숫자는 JSON 표준 표현을 사용한다. core의 알 수 없는 필드는 거절, 미래 schemaVersion은 원본 보존·쓰기 금지이다. plugin state/metadata의 확장 필드만 허용한다. snapshot hash는 이 canonical bytes에 대한 SHA-256이다. asset hash와 혼동하지 않는다. 로컬 경로·URL·토큰·캐시는 포함하지 않는다.

초기 방어 한도: JSON 32MiB, nesting 32, title 256자, metadata 합 64KiB, plugin state 각 1MiB/전체 16MiB, tracks 128, clips 20,000, 전체 source events 1,000,000, assets 10,000, 플러그인 인스턴스 512, points/lane 100,000. 한도는 성능 보장이 아니다. 가져오기 시 크기를 먼저 검사하고 worker에서 parse/validate한다. 전체 프로젝트 파일은 04의 archive 포맷을 사용한다.

배포 이후 변경은 n→n+1 순수 migration, 단계별 검증, 원본 snapshot/asset pin, 최종 커밋 후 head 교체로 수행한다. 실패하면 head 불변. 기존 미배포 v1.1 예시는 신규 스키마에 자동 호환된다고 가정하지 않고 별도 legacy importer가 필요할 경우 명시적으로 작성한다.

## 7. 오류·성능·수용 테스트

INVALID_JSON/FIELD/LIMIT, DUPLICATE_ID, BROKEN_REFERENCE, INVALID_ROUTING은 JSON path와 원인을 반환하며 현재 프로젝트를 변경하지 않는다. ASSET_MISSING/PLUGIN_MISSING은 보존 후 degraded로 표시한다. 변환은 `{result,losses[]}`를 반환하며 TAB→MIDI에서도 현/프렛/주법 손실을 열거한다. MIDI→TAB은 명시적 새 source 생성만 허용하며 v1 자동 운지 추론은 제외이다.

작은 명령(노트 1개 수정)은 기준 fixture에서 p95 16ms 이내, 16트랙 snapshot 검증·직렬화는 worker에서 p95 500ms 목표이다. 전체 snapshot 복사를 매 포인터 이동마다 실행하지 않는다. 검증·파생 이벤트 재생성은 바뀐 source 중심으로 수행한다.

- S01: 빈 프로젝트(master 1개 포함) 및 모든 source/clip round trip 의미 동등.
- S02: invalid 범위/참조/cycle/overflow 1만 생성 입력에서 거절 및 원본 불변.
- S03: 동음이현·주법·CC·pitch bend·미설치 plugin state 보존.
- S04: split→Undo에서 원본 source hash 동일, audio split 합 정확.
- S05: clip trim/loop 경계의 반개구간·truncate 기대 이벤트 일치.
- S06: 미래 버전/실패 migration에서 저장 head 및 원본 바이트 불변.

성능·자동화 실행 방식은 05, 저장 commit은 04, 파생 이벤트는 01이 정의한다.

---

## 부록 A (저장소 보완, 2026-10-22, MVP-3) — 기타 코드·스트로크 원본

> MVP-3 지시에 따라 추가. schemaVersion 1 은 아직 배포되지 않았으므로 버전을 올리지 않고 v1 계약에 포함한다(docs/decisions/0004).

```ts
interface TabSource { /* 기존 필드 */ strums: TabStrum[] } // 빈 배열 = 스트로크 없음
interface StrumString { stringIndex: number; fret: number | null; velocity: number } // fret=null: 뮤트(x), 발음하지 않음
interface TabStrum {
  id: Id; tick: Tick; durationTicks: Tick;
  chordName: string | null;            // 보조 정보(최대 64자). 원본은 strings
  strings: StrumString[];              // 연주하는 현만 포함, stringIndex 중복 금지
  direction: 'down' | 'up';            // down: 낮은 현(index 0)→높은 현, up: 반대
  spreadMs: number;                    // 0..100, 연속 발음 현 사이 시간차
  accent: number;                      // 0..2, 현별 velocity 에 곱함(결과 1..127 clamp)
  arpeggio: null | { order: number[]; stepTicks: Tick }; // order 의 현은 strings 에 있어야 함, (len-1)*step < duration
}
```

불변조건: strum 끝 ≤ source.lengthTicks, fret 0..maxFret, fret+tuning ≤127, 뮤트가 아닌 현의 [tick, tick+duration) 은 같은 현의 TabNote·다른 strum 과 겹치지 않는다(경계 접촉 허용). ID 는 전역 유일(copy-on-write 시 재발급). 박자 위치는 960 PPQ 정수 Tick 이며, 현 사이 ms 시간차는 원본에 ms 로만 저장하고 frame 변환은 파생 이벤트에서 수행한다. MIDI export 시 strum 은 개별 노트로 전개되며 방향·강세 패턴과 tick 양자화는 손실 목록에 보고한다. 팜뮤트·데드 스트로크 전용 음원은 후속 범위다.

## 부록 B (저장소 보완) — 구현 중 확정한 세부

- 파라미터 ID 정규식: `[a-z][a-zA-Z0-9._-]{0,63}` (decisions/0001)
- 전역 ID 범위, drum pad ID 예외 (decisions/0003)
- 플러그인 descriptor 계약 위치 `packages/schemas/src/plugin-contracts.ts` (decisions/0002)
