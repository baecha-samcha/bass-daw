# 0012 — 베이스 악보 출력: alphaTab(렌더 전용)과 별도 기보 모델

- 상태: 적용(로컬). 2026-10-23.
- 라이브러리: `@coderline/alphatab@1.8.4`(2026-07-05 배포, `apps/web` 의존성). 교체 없음.

## 라이선스 확인(패키지 동봉 파일 기준)
- alphaTab: MPL-2.0(파일 단위 copyleft). 수정 없이 번들에 포함하는 사용은 허용되며, alphaTab 파일을 수정해 배포하면 그 파일의 소스 공개 의무가 생긴다. 현재 수정 없음. 배포 시 고지(라이선스 텍스트·출처) 필요.
- 통합 라이브러리(LICENSE.header): TinySoundFont/SFZero/Haxe std/SharpZipLib 등 MIT.
- Bravura 폰트: SIL OFL 1.1 — `apps/web/public/alphatab/font/` 에 수정 없이 OFL·FONTLOG 와 함께 둔다.
- soundfont(sonivox)는 재생용이라 쓰지 않으며 앱에 포함하지 않는다.

## 사용 범위
- 렌더만: `player.enablePlayer=false`, MIDI·soundfont·재생 API 미사용. 기존 Project 모델·오디오 엔진 변경 없음.
- `core.engine='svg'`, `useWorkers=false`(번들의 Vite 플러그인 `@coderline/alphatab/vite` 는 1.8.4 에서 deprecated·파일 누락 → 별도 패키지 추가 대신 폰트만 public 으로 제공, 메인 스레드 렌더), `enableLazyLoading=false`(인쇄), 페이지 레이아웃.
- alphaTab 은 악보 화면을 열 때만 동적 import(별도 chunk ≈1.2MB, 재생·편집 초기 로딩과 분리). 폰트는 SW shell 에 포함(오프라인 인쇄).
- 렌더 전 `score.finish(settings)` 필수(importer 와 같은 모델 연결 — 붙임줄 origin, 슬라이드 대상, hammer 대상 확정).

## 기보 모델(`packages/notation`)
- 원본 TAB → `NotationScore`(마디·beat·음가·붙임줄·쉼표·주법·진단). 원본은 읽기만 한다(테스트: canonical hash·JSON 동일).
- 클립: 재생 전개와 같은 의미(`clipWindows`, 노트 끝은 클립 끝에서 truncate, muted 클립 제외+진단).
- 음가: 온·2·4·8·16·32·64분 + 점 1·2개. 셋잇단 등은 미지원 → 해당 마디를 비우고 경고 문구 + error 진단(근사 표기 안 함).
- 겹침: 같은 현 동시 발음(겹치는 클립) → 뒤 음 제외 + error 진단. 다른 현의 다른 시작/끝 겹침 → 한 성부의 붙임줄 화음 조각으로 표기 + warn 진단.
- 주법: slap/pop(alphaTab 은 beat 단위 → 화음 혼합 시 warn), slide → Shift slide(재생이 목표 음을 다시 어택), hammer-on/pull-off, mute → dead note(x), 화음 strum → 화음(spread 는 info), arpeggio → 생략+error, bend → 표기 안 함+warn. 연결 대상이 범위·클립 밖이면 기호 생략+warn.
- 범위: 마디 범위 인쇄 시 앞에서 이어지는 음은 origin 없이 시작(info), 뒤로 이어지는 음은 열린 붙임줄(info). alphaTab 마디 번호는 1부터라 범위 인쇄에서는 숨기고 부제에 범위를 적는다.
- 셈여림: 모델에 없다(velocity→dynamics 미지원). alphaTab 기본 f 가 임의로 찍혀 숨김(EffectDynamics=false).

## 음높이·현 순서(명시적 변환)
- 저장 음높이 = 실제 음(sounding) = `tuning[stringIndex] + fret`. 오선보 표시 = sounding + 12. 근거: 베이스 기타는 기보보다 한 옥타브 낮게 울린다("Double bass, bass guitar, guitar, and contrabassoon sound an octave lower than written." — Wikipedia, Transposing instrument).
- alphaTab: `displayValue = realValue − displayTranspositionPitch`(1.8.4 실측) → `Staff.displayTranspositionPitch = -12`, 재생용 `transpositionPitch` 는 0 그대로.
- 현 순서: 원본 tuning 낮은 현→높은 현, `stringIndex 0` = 가장 낮은 현. alphaTab `Tuning.tunings` 는 높은 현→낮은 현(기본 튜닝 실측 `[43,38,33,28]`), `Note.string` 1 = 가장 낮은 현(d.ts 문서). 변환: `tunings = reverse(tuning)`, `string = stringIndex + 1`. alphaTab 의 6현 기본값은 기타라서 항상 튜닝을 명시한다.
