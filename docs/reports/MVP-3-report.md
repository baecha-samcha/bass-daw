# MVP-3 보고서 — TAB·피아노 롤·드럼·다중 트랙 작곡

작성 2026-10-23 · 환경: Pi 4B Node, headless Chromium 154(데스크톱 1280×800 + 모바일 390×800 touch 에뮬레이션), 실제 모바일 없음

## 1. 구현된 사용자 흐름과 변경 파일

- 타임라인(`apps/web/src/ui/Timeline.tsx`): 다중 트랙, 클립 드래그 이동(트랙 간 이동 포함)·양끝 트림·Shift 다중 선택·혼합(음악+오디오) 이동 preview 와 양자화 차이 표시, 재생위치 분할·복제·클립 루프·길이 수치 입력·삭제, snap(1bar~1/32, 셋잇단, off)·줌, 눈금자 seek, 루프 영역 표시. 드래그는 preview 후 pointerup 에 명령 1개.
- TAB 편집기(`TabEditor.tsx`): 현/프렛 그리드(높은 현 위), 클릭 추가, 숫자키 프렛(2자리), ←→ 이동, ↑↓ 현, [ ] 길이, Delete, 드래그 이동/길이, 튜닝 프리셋(bass 4/5/drop D, guitar 6/7/drop D), source 길이(마디), 노트 속성 패널(현·프렛·시작·길이·세기·mute/slap/pop/hammer-on/pull-off/slide/bend).
- **코드·스트로크**: 코드 모양 선택 후 클릭으로 strum 추가, 속성 패널에서 현별 연주/프렛/뮤트(x)/세기, 다운·업, 현 간격 ms, 전체 강세, 아르페지오(현 순서·리듬). 원본 TAB 과 패턴 보존, 재생 시 개별 이벤트로 전개(원본 불변).
- 피아노 롤(`PianoRoll.tsx`): 클릭 추가, 드래그 이동/조옮김/길이, velocity lane 드래그, ↑↓(Shift 옥타브)·←→·Ctrl+A·Delete, MIDI 채널, sustain(CC64) 토글·pitch bend 점 추가/삭제, 수치 입력.
- 드럼(`DrumEditor.tsx`): pad×스텝 그리드(1/8~1/32, 셋잇단), 클릭/Enter/Space 토글, Shift 강세, 선택 hit velocity, choke 표시.
- 편집 → engine.prepare: 재생 중이면 이벤트 표만 교체(변경 트랙만 allNotesOff), 그래프 변경은 짧은 재진입.
- 명세 보완: `docs/specs/02-project-schema.md` 부록 A(TabStrum), `01-audio-engine.md` 부록 A.

## 2. 명령

`pnpm test` ✅, `pnpm test:e2e -- tests/e2e/m23-editing.spec.ts` ✅

## 3. 수용 테스트

| ID | 결과 | 근거 |
|---|---|---|
| E01 | PASS(데스크톱·터치 에뮬) | 네 악기 노트 생성·이동·삭제·velocity·Undo (브라우저) |
| E02 | PASS | split/duplicate/loop/trim 의미(Vitest) + 브라우저 분할·복제·루프·Undo×3 후 tracks/sources 동일, 드래그 1마디 이동 = 3840 tick |
| E03 | PASS | TAB 현/프렛/주법 편집 후 COW 원본 보존(Vitest), 브라우저 slap/현 변경/Undo |
| E04 | PASS(부분) | 눈금자 클릭 seek 위치 = 3.1.000, snap 일치, 혼합 이동 preview 문구. 줌 단계별 픽셀 일치 자동 검증은 NOT-RUN |
| E05 | PARTIAL | 버튼·입력 aria-label, TAB/피아노롤 grid 키보드 조작, 드럼 Enter 토글, 390px touch 탭→수치 입력. 자동 axe·스크린리더 수동 검증 NOT-RUN |
| S03/S04/S05/L01, A01–A05 회귀 | PASS | 전체 Vitest 통과 |
| 4악기 8마디 → 저장 → 재시작 → 같은 재생 이벤트 | PASS | 브라우저 persistent profile: 이벤트 285개 표 hash 재시작 전후 동일, 재생 underrun/late 0(headless) |
| 스트로크: 다운·업 순서 반대 | PASS | `tab-engine/test/strum.test.ts` |
| 뮤트 현 무발음 | PASS | 〃 |
| 0ms 동시, 17ms 간격 frame 1 sample 이내 | PASS | 44.1/48/96k, 독립 계산(0.5s + k·0.017s) |
| 저장·Undo/Redo 후 운지·방향·간격·강세·아르페지오 보존 | PASS | serialize/deserialize + undo/redo |
| 기존 TAB·MIDI 회귀 | PASS | |
| 실제 모바일 조작 | **BLOCKED** | 기기 없음(에뮬레이션은 승인 근거 아님) |

## 4. 결정·포맷

decisions 0004: `TabSource.strums` 필드 추가(schemaVersion 1 미배포 → 버전 유지), PerformanceEvent `timeOffsetSeconds`·`padId`. MIDI export 시 strum 손실 보고(`tab-strum`).

## 5. 미해결

- 팜뮤트·데드 스트로크 전용 음원, legato/slide 실제 샘플 없음(근사 + ARTICULATION_FALLBACK 진단). 자동 운지·총보 제외.
- 편집기는 source 좌표로 표시(공유 source 편집 시 copy-on-write 진단 토스트 없이 자동 분리).
- 실기 확인: 휴대폰에서 트랙 추가 → 클립 탭 → 편집 탭 → 그리드 탭으로 노트 추가 → 속성 패널에서 프렛 입력 → Undo.

## 6. 판정

코드 완료 ✅, 자동 테스트 ✅(E05 일부 수동 항목 NOT-RUN), 실제 모바일 BLOCKED.
