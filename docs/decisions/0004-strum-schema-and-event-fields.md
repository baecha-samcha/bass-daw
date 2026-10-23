# 0004 — 코드·스트로크 원본과 PerformanceEvent 보완 (MVP-3)

- 상태: 적용
- 요구: MVP-3 §8 — 현별 프렛/개방/뮤트, 다운·업, 현 간격(ms), 강세·현별 velocity, 아르페지오. 박자는 960 PPQ 정수, 스트로크 내부 시간차는 파생 이벤트에서 frame 으로 계산. "02/01 을 먼저 보완".
- 결정:
  - `TabSource.strums: TabStrum[]` 추가(02 부록 A). schemaVersion 1 은 미배포이므로 버전 증가 없이 v1 에 포함.
  - `EventBase.timeOffsetSeconds` 추가. ms 간격을 Tick 으로 반올림하지 않고 frame 계산 시점에 더한다 → 0ms 는 동시, 17ms 는 독립 계산 대비 ≤1 sample(테스트 `packages/tab-engine/test/strum.test.ts`).
  - `noteOn.padId` 추가: drum hit 를 pitch 가 아닌 pad 로 매핑(같은 pitch 를 쓰는 서로 다른 pad 구분, choke 그룹).
  - 뮤트 현(fret=null)은 순서 자리를 차지하지 않는다 — 다음 발음 현이 바로 이어 울린다.
- 영향: 영속 포맷 확장(필드 추가). 기존 TAB/MIDI 재생 회귀 테스트 통과. MIDI export 손실 항목 `tab-strum` 추가.
