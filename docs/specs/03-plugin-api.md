# 03 — 웹 플러그인 API 명세

버전 2.0-review · 2026-10-22 · D05 승인 전 외부 DSP 정책은 제안

## 1. 목적·범위

내장 악기/이펙트와 서드파티 플러그인이 동일한 파라미터·상태 계약을 사용하게 한다. 자체 웹 규격이며 VST/AU 바이너리 호환을 제공하지 않는다. v1은 host-provided UI, 선택적 sandbox UI, 검토된 WASM DSP만 대상으로 한다. 임의 JS DSP·네이티브 코드·DSP 네트워크 접근·사용자 파일 시스템 접근·실시간 설치는 제외이다.

중요한 한계: AudioWorkletNode를 나눠도 CPU deadline이 격리되지 않는다. try/catch는 무한 루프를 중단할 수 없다. 따라서 ‘모든 외부 DSP가 안전하게 격리됨’은 수용 기준으로 삼지 않는다. 임의 비신뢰 DSP 지원은 별도 worker block 처리의 지연과 watchdog을 검증하는 후속 ADR 없이는 열지 않는다.

## 2. Manifest·파라미터·상태

```ts
interface PluginManifest {
  apiVersion: '1.0'; pluginId: string; version: string;
  role: 'instrument'|'effect'; name: string; vendor: string;
  dsp: { abi: 'bass-daw-wasm-1'; sha256: string; path: string };
  ui: null | { path: string; sha256: string };
  channels: { inputs: 0|1|2; outputs: 1|2 };
  parameters: ParameterDescriptor[];
  articulations: string[]; // 안정적인 index; 첫 항목 'normal'
  voiceExpressions: ParameterDescriptor[]; // instance parameter와 별도 namespace
  stateVersion: number; maxStateBytes: number;
  maxMemoryPages: number; maxBlockFrames: number;
  latencyFrames: number; tailFrames: number|null;
  permissions: ('read-selected-assets')[];
  license: string;
}
interface ParameterDescriptor {
  id: string; name: string; unit: string;
  min: number; max: number; default: number;
  scale: 'linear'|'log'; steps: number|null;
  automation: 'sample'|'block'|'none'; smoothingMs: number;
}
interface BuiltinSamplerState {
  version: 1;
  zones: { id: Id; assetId: Id; rootPitch: number;
    minPitch: number; maxPitch: number; minVelocity: number; maxVelocity: number;
    articulation: string; loopStartFrame: number|null; loopEndFrame: number|null }[];
  pads: { padId: Id; assetId: Id; gain: number; chokeGroup: number|null }[];
  attackMs: number; releaseMs: number;
}
```

pluginId는 reverse-DNS, parameter ID는 ASCII `[a-z][a-z0-9._-]{0,63}`이며 버전 간 같은 의미에서 유지한다. 삭제/의미 변경은 major upgrade 또는 migration이 필요하다. 자동화는 02의 ownerId=instanceId로 참조한다. 값은 normalized 값이 아닌 descriptor의 물리 단위다. min<max, default는 범위 내, log는 min>0, steps는 null 또는 2 이상이다. block 파라미터는 block 시작에서만 바뀌며 UI에서 sample automation으로 표시하지 않는다.

내장 ID: `builtin.sampler`, `builtin.eq`, `builtin.compressor`, `builtin.reverb`. sampler gain=0..4/default1, attackMs=0..500/default5, releaseMs=1..5000/default80. EQ는 3개 peaking band의 frequencyHz=20..20000/default(100,1000,8000), gainDb=-24..24/default0, Q=0.1..18/default0.707이다. frequency는 실제 Nyquist의 0.49 미만으로 실행값을 제한하고 진단한다. compressor thresholdDb=-60..0/default-18, ratio=1..20/default4, attackMs=0.1..100/default10, releaseMs=10..2000/default100, makeupDb=0..24/default0, lookaheadMs=0..20/default0(정지 중 변경)이다. reverb는 IR asset을 state로 참조, wet=0..1/default0.2, dry=0..1/default1, predelayMs=0..200/default0이다. 범위·기본값은 preset이 덮어쓸 수 있으나 직렬화에 저장한다.

sampler zone은 pitch/velocity/articulation별 적어도 한 매핑, 중복 zone은 id 사전순 첫 zone 선택으로 결정적이며 진단한다. loop points는 둘 다 null 또는 0<=start<end<=asset.frameCount이다. 임의 외부 URL 대신 프로젝트 Asset ID만 참조한다. native sample 포맷은 01의 planar float32이다.

## 3. DSP ABI 1

WASM import는 host math와 읽기 전용 샘플 메모리 accessor만 allowlist로 제공한다. WASI·clock·filesystem·network import를 거절한다. 모듈은 메모리 1개, shared memory 없음, 시작 전 최대 메모리 확정, 재생 중 memory.grow 금지이다. 초기 한도는 인스턴스당 64MiB/프로젝트 전체 128MiB, state는 1MiB 이하이며 02 전체 한도를 함께 적용한다.

```ts
// WASM exports의 C 유사 선언; 모든 ptr은 linear memory의 byte offset(u32)
interface DspExports {
  abi_version(): number; // 0x00010000
  create(sampleRate: number, maxFrames: number): number; // handle, 0=실패
  alloc(bytes: number): number; // 준비 중에만 호출, 실패=0
  free(ptr: number): void; // 정지 중에만 호출
  configure(handle: number, jsonPtr: number, jsonBytes: number): number;
  bind_sample(handle: number, slot: number, pcmPtr: number,
    channels: number, frames: number, sampleRate: number): number;
  input_ptr(handle: number, channel: number): number;
  output_ptr(handle: number, channel: number): number;
  events_ptr(handle: number): number;
  params_ptr(handle: number): number;
  process(handle: number, frames: number, eventCount: number): number;
  reset(handle: number): number;
  destroy(handle: number): void;
}
```

DSP buffer는 채널별 연속 float32, 최소 maxBlockFrames(기본 512) 크기다. 실제 block이 한도를 넘으면 host가 작은 subblock으로 분할하며 이벤트 offset을 재기준화한다. process 입력은 output clear 후 전달한다. 입력 없는 instrument는 입력 ptr 호출을 생략한다. effect의 무입력 block도 tail 처리를 위해 호출한다.

configure는 정지 중 UTF-8 JSON state를 읽고 반환 전에 자체 제어 상태로 해석하며 임시 jsonPtr을 보관하지 않는다. bind_sample은 host가 alloc으로 확보한 planar PCM을 등록하고 다음 reset/dispose까지 읽기 전용으로 유지한다. host가 등록 슬롯→project assetId 매핑을 소유한다. slot은 0부터 연속, 동일 slot 재바인드는 정지 중에만 가능하다. bind_sample은 copy하지 않으며 free는 unbind/dispose 이후에만 허용한다. sampleRate와 frameCount는 원본 PCM 기준이다. DSP에서 host 자산 IO를 호출하지 않고 바인딩 메모리만 읽는다. 총 메모리 예산에 PCM 중복 복사도 포함한다. configure/bind_sample은 0=성공, 음수=오류이다.

event struct는 little-endian 32바이트: offset u32, type u32, voiceId u32, channel u32, data0 f32, data1 f32, data2 f32, reserved u32(0). type 1 noteOn(data0 pitch/data1 velocity 0..1/data2 articulation index), 2 noteOff, 3 CC(data0 controller/data1 0..127), 4 pitchBend(data0 -8192..8191), 5 voiceExpression(data0 parameter index/data1 value), 6 allNotesOff이다. 이벤트는 offset 오름차순, offset<frames이다. voiceId는 host가 active voiceKey를 u32로 매핑하고 종료 후 지연 재사용한다. 최대 1024 events/subblock, 초과 시 host가 subblock을 추가 분할하고 같은 offset의 초과는 적합성 실패로 거절한다.

voiceExpression의 parameter index는 manifest.voiceExpressions 순서다. TAB bend는 이 목록의 `pitch.semitones`(-12..12/default0)로 전달한다. 일반 MIDI channel bend와 별도 합산한다. 미지원 expression/articulation은 host가 fallback 진단을 남긴다. 노트 종료 후 voiceId는 같은 render generation 내에서 재사용하지 않으며 exhaustion 시 다음 generation으로 재준비한다.

params buffer는 descriptor 순서대로 `parameterCount*maxBlockFrames` float32 planar 값을 담는다. sample 자동화는 frames개, block/none은 첫 값을 나머지 frame에 복제한다. 값과 smoothing은 host에서 한 번만 적용한다. process return 0=정상, 1=tail 종료, 음수=fault. 포인터 정렬/메모리 범위/채널 수/finite output은 host가 검증한다. state JSON→초기 파라미터/샘플 매핑 변환은 control 영역의 adapter가 담당한다. process에서 JSON을 처리하지 않는다.

v1 ABI에서 dynamic latency와 런타임 state serialization은 지원하지 않는다. 정지 시 제어 adapter가 파라미터·preset·사용자 state를 저장한다. DSP의 지연선·리버브 버퍼 같은 transient 상태는 프로젝트 저장 대상에서 제외하며 offline renderer의 연속 block 사이에서는 유지한다. ABI와 manifest 버전 불일치는 로드를 거절한다.

## 4. 호스트 API·라이프사이클

```ts
interface PluginHost {
  inspect(bytes: Uint8Array): Promise<Result<PluginManifest>>;
  install(manifest: PluginManifest, approvedHash: string): Promise<Result<string>>;
  instantiate(pluginId: string, version: string, instanceId: Id): Promise<Result<void>>;
  setParameter(instanceId: Id, parameterId: string, value: number): Result<void>;
  restore(instanceId: Id, stateVersion: number, state: Json): Promise<Result<void>>;
  bypass(instanceId: Id, enabled: boolean): Result<void>;
  dispose(instanceId: Id): Promise<void>;
}
```

discovered→validated→installed→prepared→active→bypassed/disposed 상태를 사용한다. fault 시 faulted→bypassed, 자동 무한 재시작 금지이다. 설치는 정지 중, code hash 검증·CSP 확인·시험 렌더 후 완료한다. 실행 중 업데이트하지 않고 정확한 pluginVersion+hash를 고정한다. migration은 원본 state를 복사한 새 instance 후보에서 수행하고 실패 시 이전 state 보존이다. 외부 bundle은 프로젝트 archive에 자동 포함하지 않는다. manifest ID/version/hash와 상태만 보존한다.

## 5. 권한·UI·오류 격리

UI는 별도 origin의 sandbox iframe, allow-scripts만 기본 허용하고 allow-same-origin은 부여하지 않는다. UI capability는 host가 nonce/channel ID가 있는 전용 MessageChannel로 전달한다. opaque origin에서 origin 문자열만으로 인증하지 않고 iframe contentWindow·연결 nonce·message schema를 함께 검증한다. host→UI는 자신의 descriptor/current parameters, UI→host는 자신의 param 변경·resize·선택 asset 요청만 허용한다. 프로젝트 전체/다른 인스턴스/인증 토큰은 노출하지 않는다.

CSP connect-src 'none', form-action 'none', frame-src 제한, 임의 navigate 금지 정책을 검증한다. asset bytes는 사용자 선택과 manifest permission이 모두 있을 때 host가 제한된 handle로 전달한다. 저장소·마이크는 host UI에서만 허용한다. COEP와 sandbox plugin origin의 충돌을 M6 진입 실험으로 확인하며 실패하면 host-provided UI로 제한한다. 메시지는 64KiB, 60개/초, 초과 시 차단한다. state 1MiB는 별도 host API에서 정지 중 다룬다.

WASM trap/NaN은 해당 instance를 bypass: effect는 지연 보상된 dry 경로, instrument는 무음으로 대체한다. 5ms crossfade로 전환하고 상태는 보존한다. processorerror는 node 자체를 재생성해야 한다. 무한 루프는 같은 오디오 스레드를 멈출 수 있어 검토된 고정 hash만 실행하며 적합성 테스트는 별도 브라우저 프로세스 watchdog으로 종료한다. 이 정책이 허용되지 않으면 M6 외부 DSP 출시는 보류하고 내장 플러그인만 유지한다.

## 6. 성능·불변조건·수용 테스트

한 plugin은 01 전체 block budget의 20% 이하 p99 처리 시간을 목표로 하며 개수만큼 budget을 합산한다. PC 통과만으로 Chromebook 승인하지 않는다. process 중 allocation/memory growth/import IO 금지, output은 finite, 매 block 처리 frames 정확 일치, latency/tail descriptor와 실제 impulse 응답을 일치시킨다. 승인된 plugin도 변경 hash이면 재검증한다.

- P01: identity gain effect로 impulse/길이/mono·stereo/다양한 block 크기 ABI 적합성.
- P02: 잘못된 ptr/import/ABI/hash/state/범위·oversize bundle 거절, 기존 상태 불변.
- P03: trap·NaN 주입 시 bypass와 원본 state 보존, processorerror 후 node 교체.
- P04: 악성 UI의 다른 instance 수정·network·토큰·asset 무단 접근 차단.
- P05: unknown/missing plugin의 parameter/automation/state round trip, export 차단 확인.
- P06: 무한 루프 fixture는 격리 테스트 프로세스가 5초에 종료하며 메인 테스트 runner는 생존. 이는 제품의 실시간 격리 보장이 아님.

구현할 첫 sample 규격은 gain effect와 one-shot sampler이다. 임의 JS 플러그인 생태계까지 이 단계 완료로 주장하지 않는다. 브라우저 예외 동작 근거는 00의 MDN process 공식 문서다.
