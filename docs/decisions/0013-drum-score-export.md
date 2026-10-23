# 0013 — 드럼 악보 출력

2026-10-23 · 적용(로컬). 0012의 alphaTab 1.8.4를 유지한다. 영속 스키마·재생 엔진 변경 없음.

- 공식 `Staff.isPercussion`, `standardNotationLineCount=5`, `Clef.Neutral`, `Track.percussionArticulations`, `InstrumentArticulation`, `Note.percussionArticulation`, `Beat.preferredBeamDirection`을 사용한다. 설치된 1.8.4 d.ts 및 실제 렌더로 검증한다. 공식 웹 문서는 업데이트될 수 있으므로 버전 판정은 설치본에 근거한다.
- 도메인 변환은 `packages/notation/src/drums.ts`, alphaTab 변환은 `apps/web/src/score/drum-adapter.ts`에 둔다. `#/score-check`에서 검증 화면을 제공하며 `?scoreCase=drum-short#/score-check`로 단일 사례를 열 수 있다.
- 기보 식별자는 sourceId+padId의 튜플이다. midiPitch→GM 악기는 기본 추정에만 쓴다. padId를 숫자 음높이로 파싱하지 않는다. 기보 악기는 사용자 선택 가능하며 빈 선택은 명시적 미매핑이다. 출력 설정은 패널 세션 안에서 유지한다. 프로젝트 저장 및 스키마 변경이 필요한 영속 기보 매핑은 별도 결정 사항이다.
- 상체(스네어·림샷·사이드스틱·손 HH·탐·심벌)는 성부1/위 기둥, 발(킥·페달 HH)은 성부2/아래 기둥. 마디마다 두 성부를 독립적으로 쉼표로 채운다. 같은 tick의 타격은 해당 성부의 화음으로 모으되 중복 이벤트도 모델에서 보존하고 동일 오선 위치의 충돌을 오류 진단한다.
- 타격은 지속 음이 아니다. 타격 시각에 한 음표만 적으며 길이는 다음 타격/박 그룹 경계/8분음표 중 가장 짧은 한 음가로 제한한다. 남은 시간은 쉼표로 채운다. 붙임줄을 만들지 않는다. 1/64 격자 밖 타격/표현 불가 잔여 길이는 오류 진단한다. 튜플릿 근사 없음. 단순박은 분모 단위, 복합박(n>3이고 3의 배수)은 분모 3개 단위로 자르고, 빔은 alphaTab 박자 규칙에 맡긴다.
- velocity는 원본 값을 기보 이벤트에 그대로 보존한다. alphaTab 렌더에는 dynamics·ghost·accent로 추정 전달하지 않는다. 명시적 표현은 현 스키마에 없으며 표현 편집은 별도 확장이다.
- HH의 ○(원형 x 머리)/＋는 선택한 열린/닫힌 악기를 뜻한다. chokeGroup에 의한 샘플 종료·음원 길이를 음표 길이/닫힘/초크 표시로 추정하지 않는다. 명시적 choke 이벤트가 현 스키마에 없으므로 초크 마크 편집은 미지원이다.
- 미매핑·미지원 리듬·겹치는 머리 등 경고/오류는 화면 진단과 미리보기/인쇄의 INCOMPLETE SCORE 패널에 모두 표시한다. 범례도 인쇄한다. 렌더 완료 전 인쇄 버튼은 비활성이다. 보조 성부는 alphaTab의 기본 반투명 대신 검정으로 인쇄한다.

공식 참조(2026-10-23 확인):
- https://alphatab.net/docs/reference/types/model/instrumentarticulation/
- https://alphatab.net/docs/reference/types/model/staff/
- https://alphatab.net/docs/reference/types/model/note/
