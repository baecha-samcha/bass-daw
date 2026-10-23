# 베이스 트랙 악보 출력 — 보고서

작성 2026-10-23 · 환경: Raspberry Pi 4B(aarch64), Node 24.21.0, Chromium 154 headless(Playwright 1.64.1), poppler(pdfinfo/pdftotext/pdftoppm). 실제 프린터·Chromebook·모바일 인쇄는 확인하지 않았다(아래 BLOCKED).

## 1. alphaTab 검증 결과
| 항목 | 결과 | 근거 |
|---|---|---|
| 버전·배포 | `@coderline/alphatab@1.8.4`(2026-07-05) | npm registry |
| 라이선스 | MPL-2.0 (수정 없이 사용 가능, 수정 배포 시 해당 파일 소스 공개), Bravura OFL 1.1, 통합 라이브러리 MIT | 패키지 동봉 `LICENSE`, `LICENSE.header`, `font/Bravura-OFL.txt` |
| 렌더 전용 사용 | 가능 — `player.enablePlayer=false`, 데이터 모델 직접 생성 후 `renderScore` | `alphaTab.d.ts` 1.8.4 |
| 모델 API 실측 | `Tuning.tunings` 높은 현→낮은 현, `Note.string` 1=가장 낮은 현, `displayValue = realValue − displayTranspositionPitch` | Node 실행(실측), d.ts 주석 |
| 발견한 제약 | (1) 번들 Vite 플러그인 deprecated·파일 누락 → 사용 안 함 (2) `renderScore` 전 `score.finish()` 를 직접 호출해야 함(안 하면 null 오류) (3) 기본 셈여림 f 표시 → 숨김 (4) 6현 기본 튜닝 = 기타 → 항상 명시 (5) 마디 번호 오프셋 설정 없음 → 범위 인쇄 시 숨김 | 브라우저 실행에서 발견·수정 |

라이브러리 교체 없음. 자세한 결정: `docs/decisions/0012-bass-score-export-alphatab.md`.

## 2. 검증 화면 (`#/score-check`, 홈의 "악보 출력 검증" 링크)
| 사례 | 확인 내용 | 결과(headless Chromium) |
|---|---|---|
| 4현 표준 · TAB+오선 | 4·8·점4·16분, 마디 넘김 붙임줄(TAB 괄호), 쉼표, 4/4→3/4, 템포 100→132(마디 중간) | PASS — `tests/artifacts/score/four-both.png` |
| 5현 B E A D G · TAB 만 | 가장 낮은 B 현 개방이 TAB 맨 아래 줄 0, 튜닝 표기 "5-string bass" | PASS |
| 6현 B E A D G C · 오선 만 | 높은 C 현 개방(실음 C3) → 오선 C4(낮은음자리표 위 덧줄) | PASS |
| Drop D · 조표 D major | 사용자 튜닝, 조표 ♯2 | PASS |
| 주법 | 슬랩 S·팝 P(두 보표), 슬라이드 선, 해머온 H, 데드노트 x | PASS — `tech.png` |
| 미지원 | 셋잇단 → error 진단 + 빈 마디 "⚠ 표기 불가 리듬", 겹치는 성부 → warn | PASS |
| 120마디 | A4 여러 쪽 | PASS — PDF 3쪽, 줄(system) 잘림 없음(`long-pages.png`) |

인쇄: 검증 화면과 편집기 미리보기 모두 `window.print()` → 브라우저 인쇄 창의 "PDF로 저장". 자동 검사는 같은 print media 렌더를 Chromium `page.pdf`(A4)로 만들어 poppler 로 확인했다(전체 9쪽, 사례마다 새 쪽, 화면 UI 글자 미포함, 줄 조각 50개 모두 `break-inside: avoid`·최대 188px < A4 본문 1032px).

## 3. 출력 UI (편집기 "악보" 탭)
베이스 TAB 트랙 선택 → 범위(전체 곡 / 시작·끝 마디) → 조표(장조·단조 15개씩) → 보표(TAB+오선 / TAB / 오선) → 진단 목록 → "악보 미리보기"(인쇄용 오버레이) → "인쇄 / PDF로 저장". 베이스 TAB 트랙이 없으면 안내만 표시한다(다른 악기·녹음 자동 채보는 범위 밖).

## 4. 변환 규칙 요약
- 별도 기보 모델 `packages/notation`(도메인 패키지, alphaTab·React 비의존) → `apps/web/src/score/alphatab-adapter.ts` 가 alphaTab 모델로 변환.
- 클립 배치·트림·루프 = 재생 전개와 같은 의미, 마디 경계·음 경계 분할 + 붙임줄, 빈 구간 쉼표.
- 저장 음높이(실제)와 표시 음높이(+12) 분리, 현 순서 명시 변환(0012 참조).
- 미지원 리듬·같은 현 겹침·arpeggio = error 진단, 다성부 겹침·bend·대상이 범위 밖인 연결 주법·화음 내 slap/pop 혼합 = warn, 범위 경계 붙임줄·muted 클립·strum spread = info. 조용한 생략·근사 없음.

## 5. 테스트 (모두 이 Pi 에서 실행)
| 구분 | 명령 | 결과 |
|---|---|---|
| 변환 단위(기보 모델) | `pnpm vitest run packages/notation` | 14 passed — 음가 분해, 4/5/6현·사용자 튜닝 음높이(실제/표시), 마디 분할·붙임줄·쉼표, 클립 offset+loop+truncate(손 계산 오라클), muted, 주법, 미지원 진단, 범위·템포·박자·조표, **원본 canonical hash·JSON 동일** |
| alphaTab 모델 변환 | `pnpm vitest run apps/web/test` | 6 passed — 현 번호·튜닝 역순, alphaTab 이 계산한 realValue = 원본 음, displayValue = +12, 붙임줄 origin·슬라이드 대상·해머 대상 연결, 조표·템포 automation, 보표 플래그 |
| 실제 브라우저 렌더·인쇄 | `pnpm exec playwright test tests/e2e/score.spec.ts` | 3 passed — 7 사례 렌더(콘솔 오류 0, SVG 글자 확인), A4 PDF 레이아웃, 편집기 흐름(범위 2–3·c minor(♭3) 조표·미리보기·인쇄 1쪽·UI 미포함) 후 **projectHash·재생 계획 hash·editSeq 동일, 저장 상태 "저장됨" 유지** |
| 기존 회귀 | `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` | OK · 193 passed / 9 skipped(perf 2, workerd 계약 7) · 31 passed(9.4m) — 저장(L01/L04/L05), 재생·스케줄, 편집, 녹음, export, 플러그인, 동기화, 접근성(악보 탭 axe 포함) |
| production 번들 | `pnpm build && node scripts/check-prod-bundle.mjs` | OK (alphaTab 은 별도 chunk) |

## 6. 변경 파일
`packages/notation/{package.json,src/index.ts,test/notation.test.ts}`, `apps/web/src/score/{alphatab-adapter,render,check-cases}.ts`, `apps/web/src/ui/Score.tsx`, `apps/web/src/{App.tsx,store.ts,styles.css}`, `apps/web/src/ui/{Editor,Home}.tsx`, `apps/web/vite.config.ts`(alias·폰트 precache), `apps/web/package.json`(`@coderline/alphatab@1.8.4`), `apps/web/public/alphatab/font/*`(Bravura + OFL), `apps/web/test/score-adapter.test.ts`, `tests/fixtures/bass.ts`, `tests/e2e/score.spec.ts`, `tests/e2e/m8-a11y.spec.ts`(악보 탭), `tsconfig.json`, `vitest.config.ts`, `docs/decisions/0012-*.md`. 원본 프로젝트 스키마·오디오 엔진 변경 없음.

## 7. 한계·남은 일
- BLOCKED: 실제 프린터 출력, Chromebook/모바일 브라우저의 인쇄·PDF 저장(headless Chromium 만 확인), 스크린리더로 악보 읽기(SVG 악보는 시각 자료).
- 미지원(진단 표시): 셋잇단·기타 tuplet, bend 표기, arpeggio, 셈여림, 여러 성부(voice 2), 반복 기호·D.S. 등(원본 모델에 없음), 레이아웃 세부(마디/줄 수 지정).
- alphaTab 렌더는 메인 스레드(useWorkers=false): 렌더 시간·long task 는 따로 측정하지 않았다(Pi 의 검증 화면 7 사례 전체 렌더 확인이 10초 안에 끝난 것만 관찰). 재생 중에도 렌더는 가능하지만 UI 응답이 느려질 수 있다.
- 범위 인쇄에서 앞 마디에서 이어지는 음은 붙임줄 origin 없이 시작한다(진단 info).
- MPL-2.0 고지: 배포 시 라이선스 고지 화면/문서 필요(배포 전 체크리스트).
