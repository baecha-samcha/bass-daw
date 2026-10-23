# 0003 — 전역 ID 범위와 copy-on-write

- 상태: 적용 (MVP-1)
- 02 §2는 "전역 객체 ID 중복 금지"를 요구하고 §5는 공유 source 편집 시 새 ID source로 copy-on-write한다.
- 결정: project/track/clip/source/asset/channel/send/plugin instance/automation lane과 source 내부 이벤트(note, strum, cc, pitchBend, hit) ID는 프로젝트 전역에서 유일해야 한다. copy-on-write 시 source와 내부 이벤트 ID를 모두 새로 발급하고 링크 주법(targetNoteId)을 재매핑한다.
- 예외: drum pad ID는 kit(샘플러 state의 padId→asset 매핑) 범위의 식별자이므로 source 안에서만 유일하면 된다. 복제된 drum source는 같은 pad ID를 유지해 같은 kit 매핑을 계속 사용한다.
- 영향: 검증기 DUPLICATE_ID 규칙. 직렬화 의미 변경 없음.
