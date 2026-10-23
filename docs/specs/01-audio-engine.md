# 01 — 오디오 엔진 명세

버전 2.0-review · 2026-10-22 · 02의 영속 모델을 입력으로 사용

## 1. 목적·범위·책임 경계

Transport, 시간 변환, 이벤트 컴파일, 스케줄링, 내장 샘플러, 믹서, 오디오 클립, 녹음과 렌더링의 공통 경로를 정의한다. UI/Zustand·저장·네트워크는 렌더 스레드에서 접근하지 않는다. UI 렌더링이 DSP를 직접 호출하지 않게 분리하지만 운영체제 CPU 경쟁까지 제거한다고 보장하지 않는다. v1 제외: time-stretch, tempo ramp, 외부 MIDI 하드웨어 동기화, 실시간 협업, 백그라운드·화면 잠금 중 재생 보장, 음성 보정.

## 2. 스레드와 데이터 흐름

UI main thread는 편집 명령과 Transport 요청만 전달한다. music-core 어댑터는 worker에서 TAB/MIDI/drum source를 Performance Event로 컴파일한다. storage/decode worker는 원본 자산과 PCM을 준비한다. AudioWorklet은 준비된 그래프·PCM·이벤트와 파라미터만 사용한다. decodeAudioData 등 특정 브라우저 API의 실행 스레드 제약은 어댑터가 감추며 디코딩을 process()에서 수행하지 않는다.

제안 기본 구조는 내장 DSP를 단일 Worklet 그래프에 두어 mixer 라우팅과 sample-offset 이벤트 처리를 통일한다. 외부 플러그인은 별도 AudioWorkletNode를 사용하되 동일 렌더 스레드 자원을 공유한다(03 참조). React 재렌더를 오디오 클럭으로 사용하지 않는다. 그래프 수정·WASM 컴파일·메모리 증설은 정지 중 준비하고 block boundary에서 swap한다. 재생 중 바뀌는 source는 새 generation 이벤트 집합으로 교체한다.

## 3. 시간 모델 및 Performance Event

```ts
// Id, Tick, Project는 02에서 가져온다.
type EngineFrame = number; // 실제 AudioContext.sampleRate 기준 safe integer
type EventBase = {
  tick: Tick; trackId: Id; clipId: Id; sourceId: Id;
  occurrence: number; // loop 전개 순번
};
type PerformanceEvent = EventBase & (
  { kind: 'noteOn'; voiceKey: string; pitch: number; velocity: number;
    channel: number; articulation: string; stringIndex: number|null } |
  { kind: 'noteOff'; voiceKey: string } |
  { kind: 'cc'; channel: number; controller: number; value: number } |
  { kind: 'pitchBend'; channel: number; value: number } |
  { kind: 'expression'; voiceKey: string; parameterId: string; value: number }
);
interface ScheduledEvent {
  generation: number; frame: EngineFrame; sequence: number;
  kind: PerformanceEvent['kind']; payloadIndex: number;
}
interface RenderPlan {
  projectHash: string; sampleRate: number; generation: number;
  startFrame: EngineFrame; endFrame: EngineFrame;
  events: ScheduledEvent[]; graphRevision: number;
}
```

voiceKey는 clipId/source noteId/occurrence로 충돌 없이 구성한다. noteOn/off는 같은 voiceKey를 사용한다. noteOn velocity=0은 금지한다. CC 64 sustain은 채널별 유지, noteOff 후 pedal release에서 종료하며 stop/seek는 sustain을 강제 해제한다. MIDI pitch bend는 기본 ±2semitones, TAB bend는 voice expression으로 분리한다. MIDI channel 구분을 버리지 않는다.

tempo 구간 i에서 `seconds(t)=누적초_i + (t-tick_i)*60/(bpm_i*960)`이다. inverse는 구간 이진 탐색 후 실수 Tick을 반환하고, 편집 시에만 반올림한다. `frame(t)=round(seconds(t)*sampleRate)`이며 구간별 delta frame을 누적 반올림하지 않는다. 실시간 재생은 `contextAnchorFrame + round((seconds(t)-seconds(startTick))*sampleRate)`로 배치한다. 오디오 클립은 startSeconds에서 동일 frame 변환을 사용한다. 48kHz는 테스트/WAV 기본 rate이며 실제 컨텍스트가 44.1kHz이면 해당 rate로 렌더링하고 자산을 resample한다. 정수 Tick 오차와 frame 변환 오차를 별도 보고한다.

동일 frame 순서는 reset/종료 → noteOff → CC/pitch/expression → noteOn이다. 동종 이벤트는 track.order, clipId, source event ID로 안정 정렬한다. block 내부 offset은 event.frame-currentFrame이다. process()의 실제 output buffer length를 사용하고 128을 가정하지 않는다. event.frame=endFrame은 해당 block에 포함하지 않는다.

## 4. Transport 공개 API와 상태 전이

```ts
type EngineState = 'uninitialized'|'preparing'|'ready'|'playing'|'paused'|
  'suspended'|'recovering'|'error'|'closed';
interface EngineStatus {
  state: EngineState; tick: number; contextFrame: EngineFrame;
  generation: number; sampleRate: number; diagnostics: string[];
}
interface AudioEngine {
  initialize(options: { requestedSampleRate: 48000; profile: 'high'|'balanced'|'low' }): Promise<Result<EngineStatus>>;
  prepare(project: Project): Promise<Result<{ graphRevision: number }>>;
  play(startTick?: Tick): Promise<Result<EngineStatus>>;
  pause(): Promise<Result<EngineStatus>>;
  stop(): Promise<Result<EngineStatus>>;
  seek(tick: Tick): Promise<Result<EngineStatus>>;
  replacePlan(project: Project, editSequence: number): Promise<Result<EngineStatus>>;
  panic(): void;
  close(): Promise<void>;
}
```

uninitialized→preparing→ready는 명시적 사용자 gesture 후 컨텍스트 생성/resume와 자산 준비를 포함한다. ready/paused→playing, playing→paused는 위치 유지·voice 해제, stop은 ready·loop start(비활성이면 0)로 이동한다. seek는 generation 증가·기존 큐 폐기·voice와 effect tail reset·새 cursor로 이동하며 이전 playing 여부를 유지한다. suspended는 OS/browser interruption 상태다. 복귀 시 이전 위치에서 paused로 이동하고 사용자 재생을 기다린다. 오류 후 recovering은 그래프 재생성, 성공 시 paused, 실패 시 error이다. close는 모든 노드/포트/자원을 해제하고 되돌릴 수 없다.

loop [start,end)에서 end 도달 시 voice·sustain을 종료하고 start로 이동한다. tail은 v1에서 loop 경계 reset하며 짧은 5ms 전환 ramp를 적용한다. 따라서 루프 전후 리버브 연속성은 v1 보장하지 않는다. loop 내 이동은 새로운 occurrence를 사용하고 다음 반복 이벤트를 누락·중복하지 않는다. 루프·seek 상태는 오디오 frame에서 확정한 ack를 UI에 반영한다.

## 5. Scheduler·통신 계약

실시간 시계는 AudioContext frame이다. worker timer는 큐 공급용이다. 초깃값은 25ms 공급 주기, 250ms lookahead, underrun 조기 경보 100ms이며 M0/M2에서 조정한다. SAB 가능 시 SPSC ring, 불가 시 transferable ArrayBuffer batch를 MessagePort로 전달한다. 두 경로 모두 같은 generation/sequence/frame 계약을 쓴다. SAB는 crossOriginIsolated와 보안 컨텍스트가 필요하며 COOP/COEP 및 모든 자산 CORP/CORS를 M0에서 검증한다.

큐는 기본 65,536 이벤트, payload pool은 초기 할당 후 재사용한다. ring header는 read/write uint32 cursor, generation, capacity, dropped counter이며 cursor wrapping은 modulo 2^32의 unsigned 차이로 계산한다. producer는 payload를 쓴 뒤 Atomics.store(writeCursor), consumer는 load 후 읽고 readCursor를 갱신한다. consumer는 wait/lock하지 않는다. 1 slot당 header=type u32, generation u32, sequence u32, payloadIndex u32, frame float64의 24바이트 little-endian이다. payload는 plan 준비 단계의 불변 table이다. frame은 safe integer라 float64로 정확히 표현된다. 큐가 차면 producer가 재시도하고 음표를 임의 drop하지 않는다.

새 plan은 가장 이른 미확정 frame 이후 block boundary에서 교체한다. 과거 이벤트는 실행하지 않고 LATE_EVENT를 기록한다. 교체 시 영향받은 트랙 voice를 종료하고 새 plan으로 재시작한다. v1의 재생 중 음표 편집은 해당 트랙에서 짧은 재진입이 가능하며 클릭 방지 ramp를 사용한다. Transport seek/stop은 큐와 별개 control mailbox로 전달하고 generation을 invalidate한다. ack 없이 성공으로 표시하지 않는다. 2초 ack timeout이면 엔진 정지/복구로 전환한다.

main thread가 멈추면 queue가 소진될 수 있다. 연속 재생 30분 목표는 명시한 부하 조건에서 검증할 뿐 임의의 UI 정지에도 무제한 재생을 의미하지 않는다. underrun 감지 시 노트 지속을 방치하지 않고 panic 및 paused로 전환한다.

## 6. 샘플러·DSP·믹서

내장 instrument descriptor는 03의 BuiltinSamplerState를 따른다. 베이스·기타는 pitch/velocity zone, 키보드는 multisample, drum은 padId 매핑이다. PCM은 float32 planar, mono/stereo, 기준 디코딩 캐시를 사용한다. 원본 압축 파일과 디코딩 캐시는 분리한다. v1 폴리포니 high=128/balanced=64/low=32 전체 voice이며 초과 시 release 단계 중 가장 작은 amplitude 우선, 없으면 가장 오래된 voice를 5ms ramp로 회수한다. voice-steal은 진단 카운터다.

샘플러는 선형 보간을 최소 기능으로 하고 high의 resampling 품질은 M2 계측 후 선택한다. 주법 샘플이 없으면 ordinary note + ARTICULATION_FALLBACK을 반환한다. 표현 샘플 지원 없이 슬랩 소리를 지원한다고 표시하지 않는다. preset 라이선스와 오프라인 캐시 가능 여부는 M2 출하 게이트이다.

라우팅은 track instrument/audio→insert effects→channel gain/pan→output bus→master이다. pre-send는 insert 후 gain/pan 전, post-send는 gain/pan 후다. mute는 output과 sends 모두 차단한다. solo는 선택 채널과 그 downstream bus·send return을 살리고 다른 원천 트랙을 차단한다. master는 solo 대상에서 제외한다. pan은 mono constant-power, stereo balance로 명시한다. 내부 합산 float32, NaN/Infinity는 해당 인스턴스 출력을 0으로 치환하고 fault를 올린다. master 과출력은 peak meter로 표시하고 자동 normalize하지 않는다.

파라미터 수동 변경은 gain/pan 5ms smoothing, 자동화 ramp는 02의 envelope를 sample 단위로 계산한다. 파라미터별 smoothing과 automation을 중복 적용하지 않는다. M5의 EQ는 biquad, compressor는 명시적 latency, reverb는 제한된 IR convolution 계약이며 preset과 파라미터 범위는 03의 descriptor로 정의한다.

PDC: 각 path의 누적 latencyFrames를 계산해 합류점에서 가장 긴 경로에 맞춰 짧은 경로를 지연한다. 최대 보상은 48kHz에서 96,000 frames(2초), 다른 rate는 비례한다. 초과 그래프는 거절한다. latency 변경은 정지 중 그래프 재빌드가 필요하다. tailFrames는 latency와 구별하고 export 종료 후 tail에만 반영한다.

## 7. 녹음·파형·오디오 편집

M4 전에는 녹음을 구현하지 않는다. getUserMedia는 사용자 gesture에서 요청하고 권한 거부·장치 없음·장치 제거를 구분한다. 기본 dry capture는 echoCancellation/noiseSuppression/autoGainControl=false를 요청하며 실제 적용 settings를 기록한다. MediaRecorder codec을 원본 PCM 정확도의 기준으로 사용하지 않고 capture Worklet에서 PCM block을 worker로 전달하여 OPFS 임시 세그먼트에 기록한다. input/output sampleRate가 다르면 변환을 기록한다.

녹음 상태는 idle→requesting→armed→recording→finalizing→committed, 실패 시 recoverable/error이다. transport running 상태에서 start/stop은 capture frame ack로 확정한다. 세그먼트는 5초 단위 또는 정지 시 close/hash하고 복구 journal에 추가한다. 닫힌 세그먼트만 복구를 보장하며 마지막 미완료 세그먼트는 보장하지 않는다. 설정 실패나 quota 시 녹음을 중단하고 닫힌 세그먼트와 기존 프로젝트를 보존한다.

녹음 지연 보정: 자동 baseLatency/outputLatency 추정값은 표시용이며 정답으로 쓰지 않는다. 유선 loopback pulse 10회로 시스템 round-trip의 중앙값을 구해 capture frame과 transport frame의 배치 보정값을 계산한다. 같은 clock 기준의 실제 input timestamp가 있으면 분리 계산하되 가용성을 기록한다. 사용자 보정(ms)을 별도로 유지한다. 무보정 원본과 capture origin은 보존하고 배치 offset만 바꾼다. 음수 시작이 되면 0 이전 구간을 clip selection에서 제외하고 원본은 유지한다. Bluetooth/장치 변경 시 기존 보정은 stale 표시한다. 모니터링은 기본 off, 사용자가 명시적으로 켠다.

파형은 worker에서 min/max 피라미드(256/1024/4096/16384 source frames per bucket)로 계산한다. 파형은 캐시이고 원본이 아니다. 오디오 trim/split/fade는 02의 원본 프레임 좌표를 사용하며 overlap 클립은 합산한다. 파형 재생성 실패는 음악 데이터 손실을 일으키지 않는다.

## 8. 오프라인 렌더·내보내기

```ts
interface ExportOptions {
  startTick: Tick; endTick: Tick; sampleRate: 44100|48000|96000;
  format: 'wav-pcm24'|'wav-float32'; tailSeconds: number;
  seed: number; allowFallbacks: boolean;
}
interface RenderReceipt {
  outputAssetHash: string; frames: number; diagnostics: string[];
  engineVersion: string; pluginHashes: string[];
}
```

동일 source adapter·DSP·automation 로직을 실시간/오프라인에서 공유한다. 오프라인 frame=0은 선택 startTick의 초, 끝은 endTick의 초로 계산한다. tailSeconds 기본은 descriptor 최대 tail, 무한 tail은 사용자 지정 상한 10초로 제한한다. latency pre-roll을 추가 렌더하고 export에서 정확히 제거한다. tail을 PDC로 착각해 제거하지 않는다. seeded randomness를 사용하고 네트워크는 렌더 중 금지한다. missing assets/plugins는 기본 export 차단, 명시적 allowFallbacks일 때만 진단을 동반하여 무음/bypass로 출력한다.

긴 곡은 전체 OfflineAudioContext PCM을 동시에 메모리에 올리지 않고 state를 유지하는 worker block renderer로 WAV를 스트리밍한다. WebAudio 내장 node에만 의존한 effect는 이 경로와 공유할 수 없으므로 동일 DSP 구현이 필요하다. 파일은 임시 출력에 쓰고 완료 후 사용자 다운로드로 제공한다. v1 RIFF 4GiB 한도를 넘으면 사전 거절하고 범위 축소를 요청한다. float32는 clipping하지 않고 pcm24는 명시적 clamp 및 고정 seed TPDF dither를 적용한다. 자동 normalization은 제외이다.

MIDI export는 SMF type 1, division=960, tempo/meter 포함, CC/pitch bend 보존, audio/FX/현·프렛/주법 손실 목록을 반환한다. 세밀한 주법을 조용히 다른 음악으로 바꾸지 않는다.

## 9. 오류·성능·수용 테스트

CONTEXT_SUSPENDED, ASSET_NOT_READY, LATE_EVENT, QUEUE_UNDERRUN, DSP_FAULT, MEMORY_BUDGET, CAPTURE_LOST, EXPORT_LIMIT을 구분한다. DSP 예외는 node 재생성 없이 회복된 것으로 간주하지 않는다. 진단 통신은 초당 10회 이하, meter는 UI 30Hz 이하이다. process()는 동적 대량 할당, fetch, 파일 접근, JSON parse, log, await를 금지한다.

기준 Chromebook decoded PCM+DSP budget=192MiB, 전체 앱 working set 목표 512MiB 이하, low PCM budget=96MiB이다. 추정 메모리가 넘으면 load 전에 경고하고 freeze/bounce 또는 음원 축소를 제안한다. 품질 변경으로 저장 원본·note timing을 바꾸지 않는다. adaptive 자동 변경은 사용자 허용 시에만, profile을 보고서에 남긴다. 실제 기기에서 process block 시간 p99가 block 예산의 60% 이내를 목표로 하되 측정 자체의 부하를 별도 계측한다.

- A01–A03: tempo 구간의 frame 오차 ≤1 sample, 동일 frame 순서, block/loop 경계 중복·누락 0.
- A04–A06: stop/seek/suspend panic, plan generation 교체, 기준 16트랙 30분.
- A07–A10: 자동화 ramp, PDC impulse 정렬, seeded offline repeat, profile별 timing 일치.
- R01–R05: capture 권한/제거/중단, 세그먼트 복구, 보정 후 loopback 잔차, 원본 프레임 보존.
- X01–X04: WAV 길이/포맷/수치, MIDI 재가져오기·손실 보고, 장시간 메모리 제한.

정량 fixture와 관측 한계는 05를 따른다. 근거: 00의 W3C Web Audio 및 MDN AudioWorklet 공식 자료.

---

## 부록 A (저장소 보완, 2026-10-22, MVP-2/3)

1. **PerformanceEvent 추가 필드** (decisions/0004): `EventBase.timeOffsetSeconds: number`(기본 0, 스트로크 현 간격), `EventBase.sourceEventId`(동종 이벤트 안정 정렬 키), `noteOn.padId: Id|null`(drum pad 매핑). frame 은 `round((seconds(tick) + timeOffsetSeconds) * sampleRate)` — 구간 누적 반올림 없음. 같은 frame 정렬은 §3 그대로.
2. **큐 watermark 는 out-of-band** (decisions/0005): 공급 완료 frame 을 FIFO slot 으로 보내면 미래 이벤트 뒤에 갇혀 underrun 판정이 늦어진다. SAB 경로는 ring header word 5/6(generation, frame u32 modulo 2^32)에, MessagePort 경로는 batch 메시지 필드에 둔다.
3. **slot frame 은 context frame**: 재생 시작 control 의 ack 가 `(anchorCf, timelineFrame)` 을 돌려주고 scheduler 는 timeline→context frame 을 루프 구간별로 전개한다. 루프 경계에는 LOCATE slot(type 100)을 넣는다.
4. **재생 중 plan 교체**: slot type 상위 24bit 에 planVersion 을 넣는다. worklet 이 새 표를 받은 뒤(`plan` notice) scheduler 가 `fedUntil` 부터 새 표로 공급하고, 변경된 트랙에는 allNotesOff payload 를 같은 frame 에 넣는다. voiceKey→voiceId 는 세션 동안 안정적으로 유지한다.
5. **리버브 분할 1024** (decisions/0006): latency 1024 frames 를 선언하고 PDC/export pre-roll 로 보상.
6. 압축 포맷 디코딩 rate (decisions/0007).
