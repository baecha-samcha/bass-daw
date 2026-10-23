# 드럼 트랙 악보 출력 — 구현·검증 보고서

2026-10-23. 실행 환경: Raspberry Pi 4 Model B Rev 1.5, aarch64, Node 24.21.0, Debian Chromium 154.0.8037.57 headless, Playwright 1.64.1, poppler. **Chromebook·모바일·실제 프린터는 미검증이다. Pi 수치를 Chromebook 성능으로 간주하지 않는다.**

## 구현 범위와 공식 모델 확인

기존 `@coderline/alphatab@1.8.4`를 유지했다(라이브러리·lockfile·원본 영속 스키마·오디오 엔진 교체/변경 없음). 기존 베이스 변환은 유지하고 `packages/notation/src/drums.ts`에 별도 드럼 변환을 추가했다. 드럼 모델을 `apps/web/src/score/drum-adapter.ts`에서 alphaTab 모델로 바꾼다.

공식 문서를 확인하고 설치된 **1.8.4의 `dist/alphaTab.d.ts`와 실제 Node/Chromium 렌더**로 지원 여부를 검증했다. 웹 문서는 최신 버전으로 바뀔 수 있어 문서만으로 버전 지원을 추정하지 않았다.

| 기능 | 사용한 공식 API |
|---|---|
| 타악기·5선·음자리표 | `Staff.isPercussion=true`, `standardNotationLineCount=5`, `showTablature=false`, `Bar.clef=Clef.Neutral` |
| 오선 위치·머리 | `Track.percussionArticulations`, `InstrumentArticulation.staffLine/noteHeadDefault/noteHeadHalf/noteHeadWhole`, `Note.percussionArticulation` |
| 기호 | `MusicFontSymbol`의 일반/x/원형 x/다이아몬드 머리, `Beat.text`의 ＋/RS/ped./bell |
| 두 성부·기둥 | `Bar.addVoice`, `Beat.preferredBeamDirection`, **`rendering.BeamDirection`** |
| 빔·페이지 | alphaTab 박자별 자동 빔, 기존 SVG Page 레이아웃·system별 break-inside avoid |

공식 참조: [InstrumentArticulation](https://alphatab.net/docs/reference/types/model/instrumentarticulation/), [Staff](https://alphatab.net/docs/reference/types/model/staff/), [Note](https://alphatab.net/docs/reference/types/model/note/). 결정 기록: `docs/decisions/0013-drum-score-export.md`.

작은 검증 화면: `?scoreCase=drum-short#/score-check`. 전체 검증 화면 `#/score-check`에 기존 베이스 7개와 드럼 4개 사례를 함께 제공한다. `drum-custom`, `drum-meter`, `drum-long`도 같은 query로 단독 확인 가능하다.

## 사용 흐름

기존 편집기 **악보** 탭 → 베이스 또는 드럼 트랙 하나 선택 → 전체 곡/마디 범위 → 드럼은 pad별 기보 악기 선택 → 진단 → 미리보기 → 인쇄/PDF 저장. 드럼에서는 베이스용 조표·TAB 선택을 숨긴다. 렌더 완료 전 인쇄 버튼은 비활성이다. 인쇄 대화상자는 `window.print()`를 사용하며 자동 검증은 동일 print media를 Chromium `page.pdf()`로 저장한다.

기보 매핑은 `(sourceId, padId)` 튜플로 식별한다(여러 source의 같은 padId 간 충돌 방지). **padId 문자열을 MIDI 음높이로 파싱하지 않는다.** `pad.midiPitch`의 GM 번호는 기본 선택의 추정에만 사용하고, 사용자가 언제든 변경하거나 명시적으로 미매핑을 선택할 수 있다. 알 수 없는 번호·삭제된 pad는 추측하지 않고 `UNMAPPED_PAD`로 진단한다.

선택은 **악보 패널이 열린 세션의 출력 설정**이다. 프로젝트 저장 형식을 바꾸지 않으므로 프로젝트 재열기/패널 재마운트 뒤 영속 유지하지 않는다. 영속 기보 매핑은 스키마 변경 결정이 필요한 별도 확장이다.

## pad 기보 매핑

오선 위치는 alphaTab 규약의 **위 선=1, 아래로 선/칸마다 +1, 아래 선=9**이다. 음높이 번호가 아니다. 음표 머리 자체와 보조 텍스트를 범례에 모두 적는다. 출력물 범례에는 해당 출력 범위에서 실제 사용된 기보 악기만 포함한다.

| 기보 악기 | 위치 | 머리 | 보조 기호 | 성부/기둥 | 기본 GM 추정 |
|---|---:|---|---|---|---|
| 킥 | 8 | 일반 검정 | — | 2 / 아래 | 35, 36 |
| 스네어 | 4 | 일반 검정 | — | 1 / 위 | 38, 40 |
| 림샷 | 4 | 다이아몬드 | RS | 1 / 위 | 명시 선택(velocity로 추정하지 않음) |
| 사이드스틱 | 4 | x | — | 1 / 위 | 37 |
| 닫힌 HH | -1 | x | ＋ | 1 / 위 | 42 |
| 열린 HH | -1 | 원형 x | 원형 머리가 ○ 표시 | 1 / 위 | 46 |
| 페달 HH | 10 | x | ped. | 2 / 아래 | 44 |
| 하이 탐 | 2 | 일반 검정 | — | 1 / 위 | 50 |
| 미드 탐 | 3 | 일반 검정 | — | 1 / 위 | 47, 48 |
| 로우 탐 | 6 | 일반 검정 | — | 1 / 위 | 41, 43, 45 |
| 크래시 | -3 | x | — | 1 / 위 | 49, 57 |
| 라이드 | 1 | x | — | 1 / 위 | 51, 59 |
| 라이드 벨 | 1 | 다이아몬드 | bell | 1 / 위 | 53 |

## 변환·진단 규칙

- 클립 배치·트림·루프는 기존 `clipWindows`와 반개구간 규칙을 사용한다. muted 클립은 재생처럼 제외하고 info를 남긴다. 출력 범위 밖 이벤트는 제외한다. 전체 곡 끝은 다른 트랙의 클립 길이도 포함한다.
- **상체=성부1↑, 킥/페달 HH=성부2↓**로 배정한다. 마디별 두 성부를 독립적으로 쉼표로 채운다. 같은 tick의 같은 성부 타격을 화음으로 묶고, 다른 성부 동시 타격도 유지한다. 동일 패드의 중복 클립도 이벤트 모델에서는 모두 유지한다. 같은 오선 위치의 머리가 겹치는 경우 `OVERLAPPING_DRUM_HEADS` 오류로 시각적 충돌 가능성을 표시한다.
- 타격은 지속 음이 아니다. 한 타격당 음표 하나이며 다음 타격/박 그룹 경계/8분음표 이내에서 음가를 정한다. 나머지는 쉼표다. 심벌을 긴 지속 음이나 붙임줄로 늘리지 않는다.
- 단순박은 분모 한 박, 복합박(분자가 3보다 큰 3의 배수)은 분모 세 박마다 분할한다. 온음표~64분음표·점/겹점 음가를 사용한다. 빔은 alphaTab의 박자별 기본 규칙으로 렌더한다. 1/64 격자 밖 타격·표현 불가 잔여 길이는 `UNSUPPORTED_RHYTHM` 오류와 이벤트 ID/마디를 남긴다. 튜플릿을 근사하지 않는다.
- `velocity`는 기보 이벤트에 원본 그대로 남긴다. 약한 음을 ghost, 센 음을 accent로 바꾸지 않는다. alphaTab의 임의 기본 f도 숨긴다. 명시적 표현 모델·편집은 별도 확장으로 남긴다.
- 열린/닫힌 HH 표시 = 선택한 기보 악기 종류다. `chokeGroup`의 샘플 종료 의미와 음원 길이를 악보 지속 길이·자동 닫힘/초크 기호로 해석하지 않는다. 원본에는 명시적 choke 이벤트가 없으며 `CHOKE_PLAYBACK_ONLY` info와 인쇄 범례 설명으로 구분한다.
- 미매핑·미지원 리듬·누락 source·머리 충돌은 화면 진단과 **인쇄 가능한 INCOMPLETE SCORE 경고 패널**에 모두 표시한다. 이미 지원되는 다른 타격은 유지한다. 빠진 음을 정상 악보처럼 무경고 제공하지 않는다. 렌더 오류/진행 상태도 인쇄에서 숨기지 않는다.
- alphaTab 기본 보조 성부는 회색이므로 인쇄에서는 검정으로 설정했다. 범례·경고·악보를 같은 186mm 폭으로 배치한다.

## 자동 검증

`pnpm typecheck` PASS, `pnpm test` **202 passed / 9 skipped**(기존 성능·workerd 환경 의존 skip). 새 드럼 변환 8개·alphaTab 모델 1개 단위 검사가 포함된다. **`pnpm test:e2e`: 34 passed (9.7분)** — 새 드럼 브라우저 검사3개와 기존31개 모두 통과했다. 기존 베이스 검증 화면/편집기/PDF, 저장·복원·녹음 복구·재생·내보내기·플러그인·동기화·접근성·메모리 회귀를 포함한다. 배포용 `pnpm build`와 `node scripts/check-prod-bundle.mjs`도 PASS(가짜 인증/e2e hash/로컬 API 미포함). 최종 전체 결과는 `tests/artifacts/e2e-results.json`이다. 실기와 분리한 Pi Node/headless 근거다.

드럼 개별 PDF는 짧은/사용자 정의/범위 사례 각각 1쪽, 120마디는 **9쪽**이다. system별 높이와 `break-inside: avoid`를 자동 검사했다. 별도 `pdftotext -bbox` 점검에서 네 PDF의 모든 페이지 글자 bounding box가 페이지 범위 안에 있었다(`pdf-bounds.json`). 120마디 PDF의 첫 두 쪽과 마지막 쪽을 raster로도 확인했다(`long-page-*.png`, `long-last-9.png`).

| 사례 | 근거 |
|---|---|
| 8비트 록·킥/스네어/HH 동시 타격·velocity 1~127 | 독립 ID/velocity 집합 비교, 성부별 보존 검사, alphaTab 변환 후 노트 수 비교, 실제 SVG 음자리표/머리 glyph 검사 |
| 탐 필인·림샷/사이드스틱·열린/페달 HH·크래시·라이드 벨 | 명시 매핑한 13악기 검증 화면·PNG·PDF, 오선 위치/머리 enum 단위 검증 |
| 사용자 패드·숫자 형태의 미매핑 padId·미지원 리듬 | `custom-38`→림샷, `padId='36', midiPitch=99`→미매핑, 320tick 타격→미지원; 화면과 PDF에서 코드·이벤트 ID 검사 |
| 박자 변경·빈 마디·두 성부 쉼표 | 4/4→3/4 단위 길이 합 검사, 검증 화면의 빈 마디, 4/4→6/8 브라우저/PDF |
| 배치·루프·트림·출력 범위 | 손 계산한 시각 3840/4320/4800/5760/6240/6720 비교, 마디2–4 브라우저/PDF |
| 중복 이벤트·오선 위치 충돌 | 노트 수 보존 + 명시적 오류 진단 |
| 여러 쪽 인쇄 | 드럼120마디 A4 PDF, system 높이/분할 방지 검사 |
| 프로젝트·재생 계획 불변 | Node 프로젝트/compilePlan SHA-256 비교, 편집기 projectHash/planHash/editSeq 및 저장됨 상태 비교 |
| 기존 베이스·저장·재생 회귀 | 기존 베이스 단위·브라우저/PDF 및 전체 테스트 실행 |

아티팩트: `tests/artifacts/drum-score/{drum-short,drum-custom,drum-meter,drum-long}.{png,pdf}`, `editor-unmapped.pdf`, `performance.json`. 자동 브라우저 테스트: `tests/e2e/drum-score.spec.ts`. 변환 단위: `packages/notation/test/drums.test.ts`, alphaTab 모델: `apps/web/test/drum-adapter.test.ts`.

주의: 트랙 추가는 비동기로 음원 키트를 연결한다. hash 기준점은 이 연결이 끝난 뒤 잡는다. 연결 도중의 프로젝트 변화를 악보 출력 변화로 오인하지 않도록 테스트 대기를 명시했다.

## 성능 측정 방법·한계

베이스 짧은 곡(`four-both`, TAB+오선, 박자 변경 포함)·120마디(`long`), 드럼4마디(`drum-short`, 13악기+빈 마디)·120마디(`drum-long`, 매 마디8비트 패턴)를 **각각 별도 navigation**으로 렌더했다. alphaTab 모델 생성/finish/API 렌더 시작부터 postRenderFinished까지 `renderMs`를 기록한다(동적 import 시간 제외). `PerformanceObserver('longtask')`로 해당 navigation에서 50ms 이상 작업의 개수/총합/최댓값을 기록한다. navigation 관측에는 import·앱 초기화·후속 레이아웃/paint도 포함하므로 순수 렌더 비용과 같지 않다. 렌더 측정 구간과 겹치는 작업은 별도 `renderLongTaskCount/MaxMs`로 남긴다. 긴 task가 렌더 완료 이벤트 뒤까지 이어질 수도 있다.

| 사례 | 렌더 ms | 렌더 겹침 long task 수 / 최대 ms | navigation long task 수 / 총 ms / 최대 ms |
|---|---:|---:|---:|
| four-both | 497 | 2 / 321 | 7 / 1071 / 321 |
| long | 766 | 2 / 621 | 3 / 1393 / 651 |
| drum-short | 231 | 2 / 143 | 3 / 314 / 143 |
| drum-long | 875 | 2 / 712 | 4 / 2353 / 1438 |

한 번씩 측정한 로컬 참고치이며 기기 성능 보증·통계적 p95·Chromebook 대체 시험이 아니다. `useWorkers=false`인 기존 구성을 유지하므로 긴 곡에서는 메인 스레드 정지가 발생한다. 실제 Chromebook 상호작용·재생 중 렌더·출력 속도에 대한 합격 판정은 하지 않는다.

## 미검증·남은 확장

- **NOT-RUN:** 실제 Chromebook 렌더/long task, Chromebook PDF 대화상자, 모바일 인쇄, 실제 종이 프린터, 실제 출력의 음악가 검수. headless SVG/Chromium PDF 확인과 구분한다.
- 미지원(명시 진단): 튜플릿/64분보다 미세한 리듬, 겹치는 같은 위치 머리의 자동 분리. 키트별 전문 출판 기보 배치나 사용자 정의 머리 편집은 제공하지 않는다.
- 별도 확장: 명시적 ghost/accent/초크 표현 및 편집, 기보 매핑 프로젝트 영속 저장, 사용자 지정 빔/줄바꿈, 작업자 렌더·성능 최적화. 기존 데이터·재생 의미를 추정해서 바꾸지 않았다.

## 변경 파일·재현

- `packages/notation/src/{index,drums}.ts`, `packages/notation/test/drums.test.ts`: 출력 전용 도메인·매핑·리듬/성부·진단과 불변 검사.
- `apps/web/src/score/{drum-adapter,drum-check-cases,render,alphatab-adapter}.ts`: alphaTab 모델·검증 사례·공용 렌더 설정/측정. 기존 베이스 변환 알고리즘은 유지한다.
- `apps/web/src/ui/Score.tsx`, `apps/web/src/styles.css`: 기존 악보 탭의 드럼 선택·매핑·범례·인쇄 경고, 일관된 인쇄 폭.
- `apps/web/test/drum-adapter.test.ts`, `tests/e2e/drum-score.spec.ts`, `tests/e2e/score.spec.ts`: 모델/브라우저/PDF/성능 검사. 기존 베이스 PDF 테스트의 120마디 시작 판정은 `Long song` 제목으로 한정해 드럼120마디와 혼동하지 않도록 했다.
- `docs/decisions/0013-drum-score-export.md`, 이 보고서.

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
# 기보만 재실행
pnpm exec playwright test tests/e2e/drum-score.spec.ts tests/e2e/score.spec.ts
# 배포용 번들 확인(e2e 번들과 구분)
pnpm build
node scripts/check-prod-bundle.mjs
```

작업 시작 시 저장소 파일 전체가 untracked 상태였으므로 임의 commit/push는 하지 않았다. 검증 산출물은 기존 정책대로 `tests/artifacts/`(gitignore)에 남겼다.
