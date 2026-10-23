# MVP-2 보고서 — 샘플러·Transport·16트랙 재생

작성 2026-10-23 · 환경: Pi 4B Node v24.21.0(단위·오프라인), headless Chromium 154(실제 AudioWorklet, Pi), 실기 없음

## 1. 구현된 사용자 흐름과 변경 파일

흐름: 편집기 → "🔊 오디오 시작"(사용자 gesture, profile high/balanced/low) → ▶/❚❚/■ · Space · 눈금자 클릭 seek(재생 유지) · ⟲ 루프+마디 범위 · 트랙 M/S · 믹서 gain/pan(5ms smoothing) · "엔진 진단" 탭(상태·late/stale/underrun/voice/steal/fault·PCM MiB·scheduler 통계·F02-M2 열기).

| 위치 | 내용 |
|---|---|
| `music-core` | step tempo map tick↔초↔frame(구간 누적 반올림 없음), meter/bar-beat, PerformanceEvent, 동일 frame 우선순위, 클립 전개 |
| `tab-engine` / `midi-engine` | TAB(주법→articulation/expression, legato·slide·bend 근사 + 진단), MIDI(CC/bend/channel), drum(pad, choke) 어댑터 |
| `audio-engine/plan.ts` | Project → 그래프(위상 정렬, solo 도달, PDC) + 불변 이벤트 표(typed arrays) |
| `audio-engine/core.ts` | RenderCore: block 내부 sample offset 분할 렌더, 실제 block 길이 사용(128 하드코딩 없음), NaN→0+fault |
| `audio-engine/dsp/sampler.ts` | pitch/velocity/articulation zone(id 사전순), pad+choke, CC64 채널별 sustain, ±2st bend + voice expression, 폴리포니 128/64/32 + steal(release 최소 amplitude→최고령, 5ms ramp) |
| `audio-engine/transport.ts` | 상태 기계(01 §4), Scheduler(lookahead, 루프 전개, LOCATE, 재시도), WorkletRuntime(generation, late/stale/underrun, 조기 경보 100ms) |
| `audio-engine/ring.ts` | SAB SPSC ring(24B slot, u32 modulo cursor, Atomics, wait 없음) + MessagePort batch 동일 계약 |
| `apps/web/src/audio/*` | processor(AudioWorkletProcessor glue), scheduler.worker(25ms 공급/250ms lookahead), engine(초기화·prepare·play/pause/stop/seek/panic/close, ack 2s timeout→recovering, processorerror→노드 재생성, suspend→paused) |
| `audio-engine/synth-kit.ts` | **자체 합성** 재배포 가능 키트(seed 20261022): bass(normal/mute/slap), guitar(normal/mute), keys, drums 8 pad. 전문 음질 아님(UI·문서 표시) |
| `apps/web/src/fixtures/f02.ts` | F02 / F02-M2 생성기(16트랙, 4 bus, 10,000 노트, 120bpm, 30분) |

## 2. 명령

| 명령 | 실행 |
|---|---|
| `pnpm test` | ✅ |
| `pnpm test:e2e -- tests/e2e/smoke.spec.ts tests/e2e/m25-flows.spec.ts -g "MVP-2"` | ✅ |
| `PERF=1 F02_MINUTES=30 pnpm vitest run tests/perf` | ✅ (Pi Node 오프라인 측정) |

## 3. 수용 테스트

| ID | 결과 | 근거·수치 |
|---|---|---|
| A01 | PASS | 독립 BigInt 유리수 tempo 적분 오라클, F01(120→90→173bpm, tick 0/1/959/960/961/경계), 44.1/48/96k, block 64/128/256/512/불규칙: onset 오차 ≤1 frame(실측 max 1, 대부분 0); 30분 위치도 ≤1 |
| A02 | PASS | 같은 frame noteOff→noteOn, CC64 채널별 sustain·pedal up 해제 |
| A03 | PASS | 실시간 경로 시뮬레이션(Scheduler→SAB ring→WorkletRuntime, block 128/64/512/37/256/200, 루프 [2마디,3마디)): onset 목록이 기대와 정확히 일치(누락·중복 0), late 0 |
| A04 | PASS(엔진) / BLOCKED(실기) | 상태 기계 전이·금지 전이, pause/stop/seek 후 voice 0(5ms ramp). 브라우저: suspend/resume 버튼 진단 동작. 실제 OS interruption BLOCKED |
| A05 | PASS | seek 후 이전 generation slot 실행 0(stale 계수), ring capacity 64 overflow 시 producer 재시도·300/300 노트 전달, MessagePort 경로 동일, cursor 2^32 wrap, 큐 고갈 시 underrun→panic→idle(무음, stuck voice 0) |
| A06 | **BLOCKED** | 기준 Chromebook 30분×3회 미실행. 참고(headless Pi): F02-M2 1분 재생 중 seek/loop/mute/solo → underrun 0, late 0(시작 lead 100ms 적용 후; 60ms 일 때 late 4) |
| 내부 vs DAC | 구분 | 내부 카운터만 관측. 외부 loopback 녹음 없음 → "내부 underrun 0, 실제 출력 미검증" |

성능 참고치(Pi 4 Node, `tests/artifacts/perf/F02-M2-30min.json`): 16트랙, 140,944 이벤트/30분(평균 78/s), PCM 12.8MiB, 128-frame block 처리 p50 0.37ms / p95 0.49 / p99 0.66ms(예산 2.67ms의 25%), 이벤트 컴파일 1.1s(main thread, decisions/0008).

## 4. 결정·변경

- decisions 0004(PerformanceEvent `timeOffsetSeconds`·`padId`·`sourceEventId`), 0005(watermark out-of-band, context-frame anchor, plan 교체), 0008(컴파일 main thread 등).
- 01 명세 저장소 사본에 부록 A 추가.
- adaptive profile 자동 전환은 구현하지 않음(사용자 선택 profile 만). PCM budget 초과 시 MEMORY_BUDGET 경고.

## 5. 미해결·확인 절차

- Chromebook: `pnpm dev:https` → 편집기 → 엔진 진단 → "F02-M2 열기"(30분) → 오디오 시작 → 재생 30분 ×3(①재생만 ②10초마다 스크롤/줌/노트 이동/Undo ③편집 부하), 엔진 진단의 late/underrun/voices 기록 + 가능하면 외부 loopback 녹음.
- 합성 키트는 음질 검증 대상이 아님. 실제 음원팩 라이선스(D07) 미정.
- 재생 중 루프 토글·라우팅·자동화 변경은 짧은 재진입(pause→load→play)으로 처리 — 그 순간 끊김이 들릴 수 있음.

## 6. 판정

코드 완료 ✅, 자동 테스트 A01–A05 ✅, A06 실기 BLOCKED. 사용자 지시에 따라 MVP-3 진행.
