# MVP-4 보고서 — 오디오 가져오기·파형·마이크 녹음

작성 2026-10-23 · 환경: Pi 4B Node, headless Chromium 154 + `--use-fake-device-for-media-stream`(가짜 마이크), 실제 마이크/loopback 장비 없음

## 1. 구현된 사용자 흐름과 변경 파일

- "녹음/가져오기" 탭: 파일 선택(WAV는 자체 디코더 worker, 그 외는 브라우저 디코더) → 원본 바이트 SHA-256 저장(비파괴) → 파형 min/max 피라미드(256/1024/4096/16384, worker, OPFS `cache/waveforms` 캐시·손상 시 재생성) → 재생 위치(초 앵커)에 오디오 클립.
- 오디오 클립 편집기: 시작 초, 앞 트림, 길이, gain, fade in/out(ms), 재생위치 분할, 파형+fade 곡선 표시. 템포 변경 시 시작 초·길이 유지.
- 마이크: 입력 장치 선택, 권한 요청(PERMISSION_DENIED / NO_DEVICE / DEVICE_BUSY / CAPTURE_LOST 구분), dry 설정 요청 + 실제 settings 표시, mono/stereo, 모니터링 기본 off, 입력 레벨.
- 녹음: idle→requesting→armed→recording→finalizing→committed, 실패 recoverable/error. capture AudioWorklet → 2048 frame chunk → 5초 segment(OPFS `staging/rec-*`, hash) + IDB journal; start/stop 은 capture frame ack 로 확정, transport anchor 로 timeline 초 배치. 정지 시 segment 를 WAV(float32) 원본 자산으로 확정 → 클립.
- 장애: quota/쓰기 실패 → 녹음 중단, 닫힌 segment·기존 프로젝트 보존(recoverable); 장치 제거 → 닫힌 segment 까지 확정 + 사유 표시; 크래시 → 다음 실행 시 "미완료 녹음" 목록에서 새 오디오 클립으로 복구/버리기.
- 지연 보정: 유선 loopback 10 pulse round-trip 중앙값, 사용자 수동 ms, 장치 변경 시 STALE, 추정 base/outputLatency 는 표시만. 배치 offset = 보정 + **그래프 PDC latency** + 수동값(원본·capture origin 은 journal 보존, 음수 시작은 선택 구간에서 제외).
- 파일: `apps/web/src/audio/{recorder.ts,capture-processor.ts,media.ts,pcm-cache.ts}`, `workers/media.worker.ts`, `ui/{Record.tsx,AudioClipEditor.tsx,Waveform.tsx}`, `audio-engine/src/waveform.ts`, F02 정식(오디오 4트랙 = 60s mono 48k 합성 신호 반복 클립, sampler 대체판 F02-M2 와 구분).

## 2. 명령

`pnpm test` ✅, `pnpm test:e2e -- tests/e2e/m45-audio-export.spec.ts tests/e2e/r01-permissions.spec.ts tests/e2e/m25-flows.spec.ts` ✅

## 3. 수용 테스트

| ID | 결과 | 근거 |
|---|---|---|
| R01 | PASS(mock) / BLOCKED(실장치) | 브라우저: `--deny-permission-prompts` → PERMISSION_DENIED, 장치 없음 → NO_DEVICE; 가짜 장치 track ended → CAPTURE_LOST |
| R02 | PASS(headless) | 11.5초 녹음 중 브라우저 종료 → 재시작 → 닫힌 segment 2개(≥10s, 마지막 미완료 제외) 복구 → 새 클립. 크래시 직후 이전 탭 lease(TTL 10s) 때문에 "가져와 편집"으로 열어야 함 |
| R03 | PASS | Vitest(split 프레임 합·원본 불변) + 브라우저: WAV import SHA = 원본 파일 SHA, split 합 = 3×44100, trim·fade·Undo, 템포 120→90 후 시작 초·길이 동일, 원본 SHA 불변 |
| R04 | **BLOCKED** | 유선 loopback 장비 없음. 측정 도구만 구현(잔차 ≤5ms 판정 불가) |
| R05 | PASS(fault injection) | 녹음 중 segment 쓰기 QuotaExceeded 주입 → recoverable, "닫힌 segment 1개" 보존, 미완료 목록 표시; 장치 제거 → 확정 + 사유 |
| S04, L02–L03 회귀 | PASS | |
| 음악 편집/재생 회귀 | PASS | |

발견·수정한 결함: 장치 제거 시 강제 확정과 worklet `stopped` 경로가 동시에 finalize 할 수 있었음(클립 중복 위험) → journal 단위 1회 확정 가드. 녹음 배치에서 PDC latency 누락 → 포함.

## 4. 결정·포맷

decisions 0007(압축 포맷은 48k 디코딩 결과를 메타데이터로 기록), 0008(capture chunk 할당). 녹음 자산 license `{name:'user recording', redistribution:'allowed'}`. journal 레코드(IDB `journals`)는 프로젝트 포맷이 아님.

## 5. 미해결·실기 확인

- 실제 마이크: Chromebook 에서 녹음 탭 → 권한 → settings(실제 echoCancellation 등) 기록 → 30초 녹음 → 정지 → 재생. 탭 강제 종료 후 복구.
- loopback: 출력→입력 케이블 연결, 입력 준비 → "유선 loopback 10 pulse 측정" → 이후 클릭 트랙을 녹음해 잔차 확인(R04).
- input/output rate 가 다르면 settings 에 기록하지만 별도 resample 은 브라우저 MediaStream 경로에 맡김.
- Bluetooth·화면 잠금 녹음 보장 없음(범위 외).

## 6. 판정

코드 완료 ✅, 자동 테스트 R01(mock)/R02/R03/R05 ✅, R04 및 실제 장치 BLOCKED.
