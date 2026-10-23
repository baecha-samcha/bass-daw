# MVP-8 부분 보고서 — 외부 계정 없이 가능한 검증 (접근성·메모리·회귀·readiness)

작성 2026-10-23 · 환경: Raspberry Pi 4B(aarch64) headless Chromium 154, Node 24.21.0. **MVP-8 전체 완료가 아니다.** 실제 기기·staging·실제 인증이 필요한 게이트는 모두 BLOCKED 로 남는다. 릴리스 후보 판정은 하지 않는다.

## 1. 수행한 것

### 접근성 (`tests/e2e/m8-a11y.spec.ts`)
- axe-core(`@axe-core/playwright@4.13.0`, WCAG 2.0/2.1 A·AA 규칙)로 홈·편집기·믹서·자동화·녹음·내보내기·플러그인·동기화·엔진 진단·환경 진단 화면 검사.
- 발견·수정한 결함(첫 실행에서 실제 위반):
  - `aria-prohibited-attr`(serious): 타임라인 클립 SVG `rect` 에 role 없이 aria-label → 클립은 `role="button"`, `tabIndex=0`, `aria-pressed`, Enter/Space 로 선택. 트림 핸들은 포인터 전용으로 `aria-hidden`(키보드 대안: 클립 도구막대의 길이·분할·복제·삭제).
  - `aria-prohibited-attr`: 믹서 peak meter·녹음 입력 레벨 `div` → `role="meter"` + `aria-valuemin/max/now`.
  - `color-contrast`(serious): 선택된 토글 버튼(`button.on`) 흰 글자 대비 부족 → 배경 `#2f5f99`, 오류 텍스트 `--err` → `#f2756e`.
  - 재검사: 모든 화면 위반 0건(결과 `tests/artifacts/a11y/*.json`).
- 키보드 전용 흐름: Tab 으로 제목 입력·새 프로젝트·트랙 추가·클립 선택·Ctrl+S 저장·탭 전환, 포커스 표시(outline) 확인 — PASS.
- 한계: 자동 규칙 검사는 스크린리더 실사용을 대체하지 않는다. VoiceOver/TalkBack/ChromeVox 실사용, 모바일 터치 대체 조작 실기 확인은 BLOCKED.

### 메모리 (`tests/e2e/m8-memory.spec.ts`, `tests/e2e/m7-hash-worker.spec.ts`)
- 반복 사용 heap: 프로젝트 열기 → 재생 1.2초 → 정지 → 믹서 → (4회마다 WAV 내보내기) → 닫기 12회, 매 회 CDP 강제 GC 후 메인 스레드 JS heap. 5.13 → 약 5.7MiB, warmup 2회 제외 선형 추세 +0.37MiB(기준 10MiB 미만) — PASS(`tests/artifacts/perf/heap-cycles.json`). 30분 연속 측정(05 기준)과 실기 측정은 아님.
- 업로드 해시 worker: 128MiB 처리 중 worker heap 약 8.7MB, 메인 스레드 long task 0(대조군 318/299ms).
- 기존 수치(이전 보고서): F02 오프라인 부하·플러그인 p99 는 Pi Node 참고치.

### 통합 회귀 (Pi)
- `pnpm test` 173 passed / 9 skipped, `pnpm test:e2e` 28 passed — 손상 snapshot·quota·녹음 crash·migration(미래 버전 read-only)·sync 충돌·계정 분리·plugin fault·오프라인(서비스워커) 시나리오 포함.
- "Pi 종료" 는 오프라인 새로고침으로만 흉내 냈다(실제 Pi 전원 차단 + 배포된 서비스는 BLOCKED).

## 2. Readiness matrix

범례: PASS(자동, Pi headless/Node) · NOT-RUN · BLOCKED · 실기 = 실제 Chromebook/모바일.

| 기능 | Pi headless/Node | workerd | Chromebook 실기 | Android 실기 | iOS 실기 | desktop 실기 | 비고 |
|---|---|---|---|---|---|---|---|
| 로컬 저장·복구(L01–L05) | PASS | — | BLOCKED | BLOCKED | BLOCKED | BLOCKED | |
| 재생 엔진·스케줄(A·F02) | PASS(참고치) | — | BLOCKED(F02 30분×3) | BLOCKED | BLOCKED | BLOCKED | 오디오 기준 기기 미접근 |
| 편집기 TAB/MIDI/드럼(E) | PASS | — | BLOCKED | BLOCKED(터치) | BLOCKED | BLOCKED | |
| 녹음·보정(R) | PASS(fake mic) | — | BLOCKED(loopback) | BLOCKED | BLOCKED | BLOCKED | |
| 믹싱·WAV/MIDI export(X) | PASS | — | BLOCKED(30분 export) | BLOCKED | BLOCKED | BLOCKED | |
| 플러그인(P) | PASS | — | BLOCKED | BLOCKED | BLOCKED | BLOCKED | 별도 origin UI 미완료(D07) |
| 동기화(C01–C07) | PASS(Node 대체) | NOT-RUN | BLOCKED | BLOCKED | BLOCKED | BLOCKED | 실제 Cloudflare·공급자 BLOCKED(D07/D08) |
| 접근성 자동 규칙 | PASS | — | — | — | — | — | |
| 스크린리더·터치 대체 | — | — | BLOCKED | BLOCKED | BLOCKED | BLOCKED | |
| PWA 오프라인 cold start | PASS(headless) | — | BLOCKED | BLOCKED | BLOCKED | BLOCKED | |
| 메모리 leak(반복) | PASS(짧은 반복) | — | BLOCKED(30분) | BLOCKED | BLOCKED | BLOCKED | |

미해결 결정: D05(외부 DSP 공개 여부 — 현재 검토 고정 hash 만), D07(실기 목록·로그인 공급자·도메인·음원 라이선스), D08(예산·보존·업로드 한도).

## 3. 남은 MVP-8 항목 (실기·staging 필요)
- 기준 기기 고정 기록(브라우저·오디오 장치·rate·profile)과 같은 fixture 전체 작업 흐름.
- F02 30분×3, 30분 export, offline cold start, 2-device conflict, 원본 hash 복구 재검증(실기).
- 운영 runbook 의 staging/복제 데이터 복구 검증 — 초안 `docs/runbook.md` 는 로컬 절차만 확인.
- P0/P1 판정과 릴리스 후보 보고서.

## 4. 재현
```bash
pnpm exec playwright test tests/e2e/m8-a11y.spec.ts tests/e2e/m8-memory.spec.ts tests/e2e/m7-hash-worker.spec.ts
```
