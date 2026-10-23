# 05 — 테스트·측정·단계별 수용 명세

버전 2.0-review · 2026-10-22 · 모든 항목은 실행 전 계획

## 1. 목적·범위

데이터 보존, 음악 시간 정확도, 음향 처리, 실제 기기 안정성과 동기화 안전성을 재현 가능한 fixture로 검증한다. Vitest는 순수 도메인·DSP, Playwright는 브라우저·복구·UI 통합, 별도 오디오 harness는 실제 출력과 녹음 지연을 담당한다. fake AudioContext·headless Chromium만 통과한 결과를 제품 음질 또는 모바일 호환 인증으로 취급하지 않는다. 청감 취향·BandLab 대비 우월성·운영 SLA는 이 명세가 증명하지 않는다.

## 2. 계약 타입·공개 실행 인터페이스

```ts
interface TestEnvironment {
  runId: string; commit: string; appBuild: string;
  device: string; cpu: string; ramGiB: number; os: string; browser: string;
  audioDevice: string; sampleRate: number; blockFrames: number;
  profile: 'high'|'balanced'|'low'; powerMode: string;
  isolation: boolean; storageBackend: 'opfs'|'idb';
}
interface AudioTestResult {
  testId: string; environment: TestEnvironment; fixtureHash: string;
  status: 'pass'|'fail'|'blocked'; observations: Record<string,number|string>;
  outputHashes: string[]; artifactPaths: string[]; limitation: string|null;
}
interface AcceptanceSuite {
  runUnit(fixtureSet: string): Promise<AudioTestResult[]>;
  runBrowser(environment: TestEnvironment): Promise<AudioTestResult[]>;
  runOfflineRender(fixtureHash: string): Promise<AudioTestResult[]>;
  runHardwareAudio(environment: TestEnvironment): Promise<AudioTestResult[]>;
}
```

queued→running→pass/fail/blocked 상태를 사용한다. 장치 없음·권한 불가·loopback 장비 없음은 blocked이며 pass로 간주하지 않는다. 재실행은 새 runId로 저장하고 이전 fail을 지우지 않는다. 공개 인터페이스는 harness 계약이며 현재 실행 스크립트가 존재한다는 뜻이 아니다.

## 3. 기준 fixture

| ID | 정확한 구성 | 용도 |
|---|---|---|
| F00 | empty master, 120bpm 4/4, 자산 없음 | schema/부팅 |
| F01 | impulse·constant·sine, 위치 0/1/959/960/961 tick와 block 경계; 120→90→173 bpm | 시간/수치 oracle |
| F02 | 16트랙: bass TAB2+guitar TAB2+keyboard MIDI4+drum4+audio4; 4 buses+master | 장치 안정성 |
| F03 | 동일 source 공유·루프·트림·동음이현·주법·CC/sustain·pitchbend | 편집/변환 |
| F04 | asset 100개(총 256MiB), 3 revisions, missing/corrupt/pinned/outbox 자산 | 저장·GC |
| F05 | 두 device snapshot과 같은 base, 삭제·동일 이름·다른 자산 변경 | sync 충돌 |
| F06 | gain/one-shot sample plugin, trap/NaN/잘못된 ptr/무한 루프 | 적합성/장애 |

F02 상세: 30분 고정 timeline, tempo 120, meter 4/4, 음악 event 평균 80/s·최대 256/s, active sampler voice 최대 48, 48kHz stereo output, 합계 PCM asset cache 128MiB 이하. audio 4개는 각 60초 mono 48kHz float PCM segment를 반복 배치해 파일 크기를 제한한다. 이 반복은 audio source 범위를 보존한 clip 복제로 표현한다. 음악 source 총 10,000 notes, clip 2,000개 이하. M2는 audio clip 4개를 같은 길이의 sampler fixture로 대체한 F02-M2를 쓰고, M4 이후 F02 정식으로 다시 측정한다.

M2 부하는 gain/pan만, M5 부하는 16 channel EQ(3band), compressor 4개, reverb 1개(IR stereo 1초), sends 8개, 자동화 lane 32개/초당 10점이다. 모든 자산은 재배포 가능한 자체 합성 신호 또는 승인 음원이며 seed=20261022와 content hash manifest로 고정한다. 성능 개선 때 fixture를 가볍게 바꿔 결과를 개선한 것처럼 보고하지 않는다.

## 4. 장치·브라우저 매트릭스

| 등급 | 대상 | 필수 검증 |
|---|---|---|
| 기준 저사양 데스크톱 | 사용자 N5100/4GB Chromebook, 실제 ChromeOS Chrome | F02 30분, 편집, OPFS/PWA, PCM budget |
| 보조 Linux | 같은 Chromebook Linux Chrome, 가능 시 | M0에서 앱 성능·오디오 차이 기록 |
| 고성능 데스크톱 | Ryzen5600/16GB, OS와 실제 오디오 장치 기입 | high profile, offline/export, stress |
| 개발 서버 | Pi4B/8GB/SSD | install/typecheck/build/test 시간, HTTPS 원격 연결; 오디오 기준 장치 아님 |
| Android | 실제 기기/OS/RAM을 M0에서 확정, Chrome | 터치·녹음·다운로드·메모리·PWA·F02 |
| iOS/iPadOS | 실제 기기/OS/RAM을 M0에서 확정, Safari | 같은 핵심 흐름, suspension·권한·저장 |
| 추가 데스크톱 | Firefox/Safari 실제 지원 대상 버전 | 기능 탐지/저장/재생/export 회귀 |

브라우저는 시험 당시 stable와 직전 major를 고정 기록한다. emulator만으로 모바일 승인을 내리지 않는다. 실제 모바일 장치가 없으면 해당 제품 게이트는 blocked다. 모바일은 같은 모델/핵심 편집·녹음·export를 제공하되 허용 voice/cache 및 동시 트랙 부하는 측정 후 profile로 표시한다. 모바일 F02 성능 실패를 핵심 기능 삭제로 해결하지 않고 명시적인 capacity 제한·freeze 작업 흐름을 검토한다.

## 5. 오디오 오라클·성능 측정

시간 oracle은 엔진 tickToFrame을 재사용하지 않고 독립적인 tempo 구간 적분 계산기로 expected frame을 산출한다. 테스트 instrument는 latency=0의 단일 impulse이며 onset absolute error<=1 frame이다. 모든 Tick 값의 근본적 양자화 손실은 별도 항목이다. begin/end/loop/tempo/동일 frame priority/다양한 block(64/128/256/512)을 포함한다. browser 실제 block은 관측 값을 보고한다.

DSP 검증: identity float 출력 max abs error<=1e-6, gain/constant/sine의 analytic expected와 max abs error<=1e-5 목표. EQ/컴프/reverb는 개별 transfer/impulse/release 특성 및 finite output을 검증하며 브라우저간 파일 bit-exact를 요구하지 않는다. 같은 engine/version/seed/platform offline 반복 결과는 동일 hash를 목표로 한다. resampler/플랫폼 부동소수점 차이는 tolerance와 원인을 fixture별 기록한다. WAV header·길이·channel layout·PCM quantization은 byte parser로 별도 검증한다.

30분 재생 시험은 전원 연결·전경 탭·내장/유선 오디오·고정 profile로 3회 수행한다. 1회는 재생만, 1회는 10초마다 스크롤/줌/노트 이동/Undo·autosave, 1회는 지원된 범위의 background upload(클라우드 단계 이후) 및 편집 부하다. Bluetooth와 background tab은 별도 탐색 시험이며 baseline에 섞지 않는다.

‘끊김 0’은 (a) scheduler late/underrun/voice-stuck/fault 카운터 0 (b) 외부 loopback 녹음에서 검증 신호의 결손·불연속 0을 모두 만족하는 목표다. 내부 카운터만으로 OS·DAC 출력 결함까지 관측했다고 주장하지 않는다. baseline 오디오에 전용 marker/pilot 채널을 추가한 F02-observed를 쓰며 그 추가 부하를 보고한다. 외부 레코더의 clock drift는 시작·주기 marker로 보정하고, 정상 트랙 무음과 underrun을 구분한다. pilot 검출 threshold·false positive는 알려진 1/16/128-frame dropout 주입으로 검증한다. loopback 장비가 없으면 ‘내부 underrun 0, 실제 출력 미검증’으로 표기한다.

각 시험은 frame count, queue watermark, late count, process p50/p95/p99, UI long tasks, load time, memory peak, profile 전환, CPU throttling·온도 가능 정보, 청감 메모를 기록한다. Worklet wall-time 계측 API는 브라우저에서 가용성이 다르므로 diagnostic build와 browser tracing을 사용하고 sampling overhead를 별도 기록한다. 직접 deadline 계측이 불가능하면 추정치를 p99 실측이라고 쓰지 않는다.

메모리는 01 budget을 쓰고 full heap을 지원하지 않는 브라우저는 도구·측정 범위를 기록한다. 30분 구간에서 지속 증가가 10MiB 초과하면 leak 조사 대상으로 차단한다(일회성 캐시 warmup 2분은 별도). 녹음 보정은 유선 10pulse 중앙값 calibration, 다음 10pulse에서 residual 중앙값 절대값<=5ms 목표, 분산·최댓값을 함께 보고한다. 기기·rate 변경은 재측정한다.

## 6. 테스트 ID와 자동화 경계

| ID | 핵심 assertion | 수단 / 게이트 |
|---|---|---|
| S01 | 모든 타입 canonical round trip, 날짜/ID 보존 | Vitest / M1 |
| S02 | 10,000 invalid generated cases 거절, 원본 불변 | seeded generator+Vitest / M1 |
| S03 | 동음이현·표현·unknown plugin 보존 | Vitest / M1 |
| S04 | split/Undo source hash 및 프레임 합 보존 | Vitest / M1, M3 재검증 |
| S05 | trim/loop 반개구간 기대 이벤트 | Vitest / M1, M2 |
| S06 | migration 실패/미래 버전 쓰기 금지 | Vitest+browser / M1 |
| L01 | offline restart 마지막 completed head 복구 | Playwright persistent context / M1 |
| L02 | commit 경계별 강제 종료·재시작 old/new head만 | fault injection+browser / M1 |
| L03 | quota·OPFS 없음·자산 손상 시 원본 보존 | browser adapters+실기 / M1 |
| L04 | 동시 탭 epoch/head CAS | Playwright 2 pages / M1 |
| L05 | archive hash/악성 ZIP/취소 시 원본 불변 | Vitest+browser / M1 |
| B01 | cached PWA offline cold start, update 중 reload 없음 | browser+실기 / M1 |
| A01 | tempo 적분 impulse 오차 ≤1frame | offline oracle / M2 |
| A02 | 동일 frame ordering 및 sustain | Vitest/render / M2 |
| A03 | block/loop boundary note 누락/중복 0 | render / M2 |
| A04 | play/pause/seek/stop/suspend voice 종료 | browser+audio render / M2 |
| A05 | stale generation 실행 0, queue overflow 무손실 거절 | Vitest/browser / M2 |
| A06 | F02-M2 30분 3회, 끊김 목표 만족 | 실제 기기+harness / M2 |
| E01 | 네 악기 노트 생성·이동·삭제·velocity·Undo | browser 데스크톱+터치 / M3 |
| E02 | clip trim/split/loop/duplicate 의미 동등 | Vitest/browser / M3 |
| E03 | TAB string/fret/technique 편집 후 원본 보존 | browser/render / M3 |
| E04 | zoom/snap/time ruler 일치, mixed move preview | browser / M3 |
| E05 | 키보드 탐색·포커스·screen reader label·터치 대체 | 자동 axe 가능 도구+수동 / M3 |
| R01 | 권한 거부·장치 없음/제거 상태 구분 | mock+실제 장치 / M4 |
| R02 | recording crash에서 closed segment 복구 | browser/harness / M4 |
| R03 | trim/split/fade 후 original SHA 불변 | Vitest/render / M4 |
| R04 | loopback 보정 residual 목표 | 실기+harness / M4 |
| R05 | 녹음 중 quota/capture lost, 명확한 미완료 상태 | browser fault injection / M4 |
| A07 | automation 선형/step sample 값 | analytic render / M5 |
| A08 | bus/send PDC impulse path 차이 ≤1frame | offline/render / M5 |
| A09 | fixed seed 반복·tail·latency 제거 | offline/render / M5 |
| A10 | profile별 timing 동일, F02 전체 30분 | 실기+harness / M5 |
| X01 | WAV PCM24/float32 header·frames·clamp/dither | byte parser+render / M5 |
| X02 | SMF 960PPQ tempo/CC/bend round trip와 losses | independent parser / M5 |
| X03 | missing asset/plugin export 기본 차단 | browser / M5 |
| X04 | 30분 export memory bound·취소·4GiB 사전 거절 | worker/browser / M5 |
| P01–P06 | 03의 ABI·권한·fault·watchdog 6개 항목 | isolated browser/harness / M6 |
| C01–C07 | 04의 CAS·재시도·인가·GC·Pi off 7개 항목 | Workers integration+2 clients / M7 |

P/C 각 ID의 상세 assertion은 해당 소유 문서를 따른다. green coverage 비율 대신 critical invariant 전 항목 통과를 요구한다. time oracle을 실제 구현으로 복사한 테스트, DOM snapshot만 보는 테스트는 수용 증거가 아니다.

## 7. CI·릴리스 게이트·복구

모든 PR: lockfile install, typecheck, lint, Vitest 도메인·DSP, 스키마 fixture, Chromium browser smoke, offline oracle. main/nightly: 전체 browser matrix 가능한 CI 환경, crash/quota/fuzz, export, API 통합. 실제 모바일·오디오 30분 시험은 M2/M4/M5/M8 게이트와 엔진 변경 릴리스 후보마다 수행한다. cloud credentials 없는 PR에서는 로컬 Workers/D1/R2 어댑터 테스트, protected staging에서 실제 서비스 통합을 수행한다. 비밀은 CI secrets로 관리하며 fixture/project에 넣지 않는다.

결함 P0=데이터 손실/다른 계정 접근/임의 원본 덮어쓰기, P1=핵심 편집·재생·저장·복구 실패, P2=우회 가능한 기능 결함이다. P0/P1 미해결이면 해당 게이트 실패. flake는 1회 재실행으로 green 처리하지 않고 격리 원인·영향·수리 작업을 남긴다. 장치가 없어 blocked인 핵심 기능도 게이트 통과로 간주하지 않는다.

M0는 기능 탐지·HTTPS·cross-origin·실제 장치 확보·위험 실험의 근거 보고가 산출물이다. M1~M7 완료는 00의 해당 테스트 전부 통과와 문서 계약 일치, M8은 모든 지원 대상의 전체 곡 흐름 및 데이터 이전 검증이다. 실패 후 수정은 영향 테스트와 필수 회귀만 다시 수행하고 이유 없이 전체 장시간 시험을 반복하지 않는다.

보고서 템플릿: runId/commit → 환경/fixture hash → testId별 pass/fail/blocked → actual vs threshold → 관측 한계 → artifact(원본 결과/렌더/trace) → 미해결 결함. 음악 사용자 데이터는 명시적 허용 없이 telemetry로 업로드하지 않고 기본 로그는 내용 대신 event count/hash/오류 코드만 포함한다.

## 8. 현재 상태

실행된 제품 테스트 없음. 본 문서 작성 과정에서 할 수 있는 검증은 파일 완전성·문서 간 참조·계약 일관성 검토뿐이다. 성능 달성·모바일 지원·플러그인 안전성이 검증됐다는 뜻이 아니다. 실제 구현 시작 전 D01–D03 및 M0 범위를 사용자에게 승인받아야 한다.
