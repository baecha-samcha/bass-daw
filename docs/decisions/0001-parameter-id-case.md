# 0001 — 파라미터 ID 대소문자 모순

- 상태: 적용 (MVP-1)
- 발견: `03-plugin-api.md §2`는 parameter ID를 ASCII `[a-z][a-z0-9._-]{0,63}`로 정의하지만, 같은 절의 내장 ID는 `attackMs`, `releaseMs`, `gainDb`, `frequencyHz`, `thresholdDb`, `makeupDb`, `lookaheadMs`, `predelayMs`, `Q` 처럼 대문자를 포함한다.
- 최소 수정안: 정규식을 `[a-z][a-zA-Z0-9._-]{0,63}`로 완화한다(첫 글자는 소문자 유지). EQ 밴드 Q는 첫 글자 규칙에 따라 `bandN.q`로 표기한다.
- 영향: 영속 포맷 의미 변경 없음(허용 집합 확대). 기존 소문자 ID는 모두 그대로 유효. 서드파티 manifest 검증(M6)도 같은 정규식을 사용한다.
- 대안: 내장 ID를 모두 소문자(`attack-ms`)로 바꾸는 안은 명세 표의 이름과 어긋나 기각.
