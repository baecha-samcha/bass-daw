# MVP-5 보고서 — 믹싱·자동화·WAV/MIDI 출력 (개인용 베타 경계)

작성 2026-10-23 · 환경: Pi 4B Node v24.21.0, headless Chromium 154. 실기 없음.

## 1. 구현된 사용자 흐름과 변경 파일

- 믹서 탭: 트랙/버스/master 스트립, peak meter(≤30Hz), gain(dB)/pan(5ms smoothing 미리보기 → 손을 떼면 Undo 가능 명령), M/S, output 선택, send 추가·gain·pre/post·삭제, insert EQ(3-band)/Compressor/Reverb(IR 자산 또는 seed 고정 합성 IR) + descriptor 기반 파라미터, 미설치 플러그인 표시, 버스 추가/삭제. feedback 라우팅은 검증기에서 거절.
- 자동화 탭: channel gain/pan·plugin 파라미터 lane, read/off, 점 추가·드래그·step/linear 전환·삭제, sample 단위 envelope(자동화 중 수동 smoothing 중복 없음).
- PDC: 경로별 누적 latency, 합류점 지연, 최대 2초(rate 비례) 초과 그래프 거절, latency 는 정지 중 재빌드. tail 과 latency 분리.
- 내보내기 탭: WAV(곡 전체/루프, PCM24 TPDF dither+clamp / float32 무클리핑, 44.1/48/96k, tail ≤10s, 누락 허용 옵션) — worker block 렌더 → OPFS `exports/` 스트리밍, 진행률·취소, 4GiB 사전 거절, receipt(frames·peak·sha256·진단). MIDI(SMF type1/960PPQ, tempo/meter/CC/bend, 손실 목록). .bassdaw 백업.
- 공유 DSP: 실시간 Worklet 과 offline worker 가 같은 RenderCore 사용.
- 파일: `audio-engine/src/{core,plan,offline}.ts`, `dsp/{biquad,compressor,reverb,fft,delay}.ts`, `midi-engine/src/smf.ts`, `apps/web/src/ui/{Mixer,Automation,Export}.tsx`, `workers/export.worker.ts`.

## 2. 명령

`pnpm typecheck` ✅ · `pnpm test`(105 pass, perf 1 skip) ✅ · `pnpm test:e2e`(16 시나리오) ✅ · `PERF=1 F02_MINUTES=30 …`, `PERF=1 F02_MINUTES=5 F02_VARIANT=full F02_M5=1 …` ✅

## 3. 수용 테스트

| ID | 결과 | 근거·수치 |
|---|---|---|
| A07 | PASS | 독립 analytic envelope: linear/step channel gain max 오차 <1e-6, 첫 점 이전 저장값, plugin(sampler gain) 자동화 |
| A08 | PASS | 직결 vs compressor lookahead 버스: impulse 도착 frame 차 ≤1(총 PDC 480 frame), 2초 초과 그래프 PDC_LIMIT 거절 |
| A09 | PASS | 같은 seed 반복 → 동일 sha256, pcm24 dither 는 seed 에만 의존, latency pre-roll 정확 제거(impulse 정확히 24000 frame), tail 렌더; 리버브 결과 block 37/128/512 동일 |
| A10 | **BLOCKED** | 실기 profile별 timing·F02 30분 미실행 |
| X01 | PASS | 독립 byte parser: RIFF/fmt/data 필드·frame 수(16s+tail)·pcm24 clamp=8388607·float32 2.7 무클리핑·저레벨 dither ±2 LSB. 브라우저 export 헤더 확인 |
| X02 | PASS | 독립 SMF parser: format 1·division 960·tempo(90bpm 은 µs 정수 표현으로 89.99995 → `tempo-rounding` 손실 보고)·meter 7/8·CC64·bend·채널·drum ch10, 재가져오기 일치, 480PPQ/비정수 배율 quantization·program change 손실 |
| X03 | PASS | 자산/플러그인 누락 시 EXPORT_BLOCKED(Vitest + 브라우저에서 OPFS 자산 삭제 후), allowFallbacks 시 진단 포함 |
| X04 | PASS(Pi Node) / BLOCKED(실기) | 30분 F02-M2 export: 519MB 출력 스트리밍 중 heap 증가 59.8MiB(출력 미보유), 6.5배속; 취소; 4GiB 사전 거절 즉시 |
| S/L/E/R 회귀 | PASS | 전체 스위트 |
| MVP-5 데모 | PASS(headless) | 드럼+오디오 import+버스/send/리버브/컴프 → WAV → 백업 → **다른 브라우저 프로필에 복원 → WAV 바이트 sha256 동일** |

부하 참고치(Pi 4 Node, 128-frame block, 실기 아님 — `tests/artifacts/perf/`):

| fixture | p50 | p95 | p99 | p99/예산 | offline |
|---|---|---|---|---|---|
| F02-M2 30분 | 0.37ms | 0.49 | 0.66 | 25% | 6.5× 실시간 |
| F02 full + M5(EQ16·comp4·reverb1·send8·자동화 32 lane×10점/s) 5분 | 1.12 | 1.52 | 1.90 | **71%** | 2.4×, heap +29MiB |

M5 부하에서 리버브가 지배적(제외 시 p99 1.30ms). 최초 p99 4.73ms → 자동화 구간 커서 2.71 → 리버브 FFT 작업 분산 1.90ms(decisions/0006, 리버브 latency 2048 frames). 목표(실기 p99 ≤60%)는 Chromebook 에서 판정 필요.

## 4. 결정·포맷

decisions 0006(리버브 분할·작업 분산·latency), 0008(구현 선택). 내장 descriptor 는 03 값 그대로(파라미터 ID 대소문자는 0001). WAV 자동 normalization 없음(F02+M5 fixture 는 clamp 진단 발생 — fixture 레벨 특성).

## 5. 미해결·사용자 선택

- 실기: Chromebook 에서 "F02 + M5 부하"(30분) ×3 재생, 30분 export 메모리(작업 관리자/performance.memory), 다른 브라우저 복원 후 WAV hash 비교.
- 리버브 사용 시 출력 지연 +42.7ms. 비균일 분할 검토는 실기 수치 후.
- 재생 중 라우팅/자동화 편집은 짧은 재진입(끊김 가능).
- 서드파티 DSP·로그인·동기화는 MVP-6/7 범위(미착수). 음원 라이선스·장치(D07), 예산(D08) 미정.

## 6. 판정

- 코드 완료: ✅ MVP-0~5 범위 구현, 개인용 베타 흐름(편집→믹싱→자동화→백업→복원→WAV/MIDI) 동작.
- 자동 검증: ✅ Vitest 105, Playwright 16 (headless Chromium/Pi).
- 실제 기기 게이트: ❌ BLOCKED — A06/A10, 실기 X04, R04, 모바일 전부. 따라서 **베타 출하 게이트는 미통과**이며, 실기 측정 후 판정해야 한다.
- MVP-6/7 은 별도 실행 지시를 기다린다.
