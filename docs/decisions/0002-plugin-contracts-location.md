# 0002 — 플러그인 descriptor 계약 위치

- 상태: 적용 (MVP-1)
- 00 §4는 플러그인 계약을 초기 `audio-engine/contracts`에 두라고 제안한다. 그러나 02 검증기(자동화 값 범위·내장 파라미터 범위)도 descriptor가 필요하고, `audio-engine`은 `schemas`에 의존하므로 반대 방향 import는 순환을 만든다.
- 결정: descriptor/manifest 타입과 내장 descriptor 표를 `packages/schemas/src/plugin-contracts.ts`에 둔다. `audio-engine`은 이를 재수출한다. M6에서 `packages/plugin-api` 분리를 다시 검토한다.
- 영향: 파일 배치만 변경. 계약 의미는 03 그대로.
