# MVP-4 — 오디오 가져오기·파형·마이크 녹음

작성일: 2026-10-22 · 대상: Raspberry Pi에서 실행하는 Codex / Claude Code

## 이번 단계의 목표

기존 곡에 보컬이나 악기를 녹음하고 원본을 유지하면서 파형 트림·분할·fade를 적용할 수 있습니다.

## 선행 조건

MVP-3 편집/타임라인과 MVP-2 엔진이 동작해야 합니다. MVP-0 capture 실험 결과도 확인해 주세요.

## 먼저 읽을 문서

이 프롬프트는 `bass-daw-mvp-prompts/` 폴더와 함께 전달됩니다. 아래 경로는 패키지 루트 기준입니다. 작업 저장소에는 명세를 `docs/specs/`에, 이 프롬프트를 `docs/prompts/`에 보존해 주셔도 됩니다. 이미 더 최신 명세가 있다면 차이를 확인하고 오래된 파일로 덮어쓰지 말아 주세요.

- `specs/01-audio-engine.md`
- `specs/02-project-schema.md`
- `specs/04-storage-sync.md`
- `specs/05-testing.md`

참조 파일이 없다면 먼저 실제 위치를 찾아 주세요. 발견하지 못하면 누락 파일명을 알려 주시고, 명세 내용을 추측해 구현하지 말아 주세요.

## 공통 작업 지침

이번 단계를 함께 구현해 주세요. 먼저 저장소와 기존 작업을 살펴보고, 아래 범위를 실제로 동작하는 결과까지 완성해 주시면 좋겠습니다.

- 실행 위치는 Raspberry Pi 4B/8GB/SSD 개발 환경입니다. Pi는 개발 서버이며 프로덕션 의존성이 아닙니다. 실제 오디오 기준 기기는 Chromebook N5100/4GB입니다.
- React + TypeScript + Vite, Zustand, Web Audio API + AudioWorklet, 960 PPQ 정수 Tick, IndexedDB + OPFS, Workers/D1/R2, pnpm Workspaces, Vitest/Playwright, GitHub Actions를 유지해 주세요. Rust/WASM은 필요한 근거가 있을 때만 도입해 주세요.
- TAB/MIDI 원본 모델은 독립적으로 보존하고 Performance Event로만 합류시켜 주세요. 원본 음원은 비파괴로 유지해 주세요. 도메인 패키지에 React/Zustand/네트워크 의존성을 넣지 말아 주세요.
- 먼저 저장소의 AGENTS.md, git 상태, 기존 구현과 이전 단계 보고서를 읽어 주세요. 사용자 변경을 덮어쓰거나 reset하지 말고 기존 프로젝트가 있으면 이어서 작업해 주세요. 빈 폴더라면 작업 폴더 이름은 bass-daw를 기본으로 사용해 주세요.
- 이 파일은 사용자가 해당 단계를 실행하라고 전달했을 때 그 단계의 구현 지시로 사용됩니다. 파일을 읽었다는 이유만으로 뒤 단계까지 실행하지 말아 주세요. 동봉 명세의 과거 ‘구현 승인 전’ 상태는 현재 전달받은 단계의 실행 지시를 취소하지 않습니다.
- 00 계획의 승인된 설계 방향과 D01–D06 기본안을 해당 범위에서 구현 기준으로 사용해 주세요. D07/D08의 실제 장치·로그인 공급자·도메인·라이선스·예산·서비스 한도는 아직 선택이 필요합니다. 필요한 시점에만 확인하고, 답변 없이 확정하거나 실제 계정/유료 리소스를 만들지 말아 주세요. 독립적인 로컬 구현은 계속 진행해 주세요.
- 문서의 모순이나 구현 불가능한 계약이 발견되면 최소 수정안과 영향을 docs/decisions/에 기록해 주세요. 확정 스택 변경·영속 포맷의 의미 변경은 사용자 선택을 받은 뒤 적용해 주세요. 단순 파일 배치·라이브러리 보조 선택은 근거를 남기고 진행해 주세요.
- 계획 제시에서 멈추지 말고 해당 범위를 구현·테스트·문서화해 주세요. 범위 안에서 작은 작업으로 나누되, 자동으로 다음 MVP에 진입하지 말아 주세요. 배포·push·외부 메시지 전송은 별도 요청이 있을 때만 수행해 주세요.
- Pi 메모리를 고려해 설치/브라우저/테스트 worker 수를 조절해 주세요. 실제 설치 버전과 lockfile을 기록하고, 버전이 필요한 API는 공식 문서를 확인해 주세요. 비밀값과 사용자 음악 파일을 로그·Git에 넣지 말아 주세요.
- 테스트의 기대값은 구현을 복사하지 않고 독립 오라클·원본 hash·상태 불변조건으로 검증해 주세요. 실행하지 못한 테스트를 통과로 처리하지 말아 주세요. Pi/headless 결과와 실제 Chromebook/모바일 오디오 결과를 분리해 주세요.

## 결과 제출 형식

`docs/reports/MVP-4-report.md`를 작성해 주세요.

1. 구현된 사용자 흐름과 변경 파일/패키지
2. 재현 가능한 설치·실행·검증 명령과 접속 방법(실제 실행한 명령만 실행 완료로 표시)
3. 수용 테스트 ID별 PASS / FAIL / BLOCKED / NOT-RUN, 환경·실제 수치·로그 위치
4. 데이터 포맷·공개 API·의존성 변경과 결정 기록
5. 미해결 결함, 사용자 선택이 필요한 항목, 실제 기기에서 수행할 짧은 확인 절차
6. 코드 완료와 실제 기기 검증 완료를 분리한 판정 및 다음 단계 진입 가능 여부

필수 테스트가 BLOCKED이면 완료를 과장하지 말고, 가능한 구현과 자동 테스트 결과는 보존해 주세요. 마지막 응답에는 결과 요약과 보고서 경로를 알려 주세요.

## 변경 범위

packages/{audio-engine,storage,project-core,ui}, apps/web의 audio track/recording UI, 관련 tests/docs.

## 구현 작업

1. 허용된 mono/stereo 오디오 import, 원본 SHA 검증, decode cache와 waveform min/max 피라미드를 worker 경로로 구현해 주세요.
2. 초 앵커의 AudioClip과 원본 sample frame selection을 timeline에 연결해 주세요. 템포를 바꾸어도 녹음 시작 초/속도/길이는 유지해 주세요.
3. 트림/분할/gain/fade/이동과 Undo/Redo를 구현하고 음악·오디오 혼합 선택 이동의 preview와 양자화 차이를 표시해 주세요.
4. getUserMedia 권한·실제 settings·장치 선택·모니터 off 기본값을 제공하고 Worklet PCM capture→worker→OPFS segment journal을 구현해 주세요.
5. idle/requesting/armed/recording/finalizing/committed 및 실패 복구 상태를 구현해 주세요. 녹음 start/stop은 실제 capture frame ack로 확정해 주세요.
6. 5초 닫힌 segment의 복구, quota/capture lost/장치 제거 시 안전 중단, 미완료 녹음 표시와 복구 선택을 제공해 주세요.
7. 유선 loopback pulse calibration, 사용자 수동 offset, 장치 변경 시 stale 표시를 제공해 주세요. 추정 baseLatency를 보정 정답으로 쓰지 말아 주세요.
8. F02의 오디오 4트랙을 실제 오디오 클립으로 전환하고 기존 sampler fixture와 혼동하지 않게 기록해 주세요.

## 완료 기준과 검증

- R01–R05, S04, L02–L03, 음악 편집/재생 관련 회귀를 실행해 주세요.
- 편집 전후 original asset SHA 동일, audio split 프레임 합 정확, 닫힌 녹음 segment crash 복구를 검증해 주세요.
- 마이크 장치·권한·실제 rate·OS 처리가 기록되어야 합니다.
- 유선 loopback 보정 후 잔차 목표는 실제 장비로만 판정하고 없으면 BLOCKED로 남겨 주세요.

테스트 ID의 정확한 assertion과 fixture는 `specs/05-testing.md` 및 해당 소유 문서를 따라 주세요. 실제 기기 수동 검증이 남아 있어도 가능한 자동 검증·실행 도구·보고서를 마무리해 주세요. 기기 접근을 이유로 모든 작업을 초기에 중단하지는 말아 주세요.

## 이번 단계에서 제외할 일

time-stretch/warp, pitch correction, Bluetooth 지연 보장, 화면 잠금 녹음 보장, MIDI 하드웨어 녹음, cloud upload.

## 사용자 확인용 데모

기존 곡 열기 → 오디오 import → 마이크 보컬 녹음 → 파형 split/trim/fade → Undo → 재시작 복구 → 템포 변경에도 원본 길이 유지.

이 흐름을 재현할 명령과 클릭 순서를 보고서에 적어 주세요. 여기까지 완료하면 결과를 정리하고 다음 MVP는 실행 지시를 받은 뒤 시작해 주세요. 함께 이어서 검토할 수 있도록 막힌 부분도 구체적으로 남겨 주시면 좋겠습니다.
