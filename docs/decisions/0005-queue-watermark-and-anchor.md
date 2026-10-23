# 0005 — 큐 watermark out-of-band, context-frame anchor, plan 교체

- 상태: 적용 (MVP-2)
- 발견: 공급 완료 watermark 를 일반 slot 으로 FIFO 에 넣으면 앞선 미래 이벤트가 소비될 때까지 worklet 이 읽지 못해, 정상 공급 중에도 underrun 으로 오판한다(A03/A05 시뮬레이션에서 재현).
- 결정: 01 §5 의 header 5 word 중 예비 word 5/6 을 watermark(generation, frame u32)로 사용. MessagePort fallback 은 batch 메시지에 동봉. slot 24B 형식은 그대로.
- slot frame 기준: AudioContext 의 context frame. play control 의 ack 가 anchor 를 반환하고 scheduler 가 timeline→context 를 전개(루프 경계 LOCATE slot).
- 재생 중 편집: generation 을 바꾸지 않고 slot type 상위 bit 의 planVersion 으로 표를 구분, `fedUntil` 이후부터 새 표, 변경 트랙만 allNotesOff. 이는 01 §5 "가장 이른 미확정 frame 이후 block boundary 교체"의 구현이다.
- 그래프(라우팅·이펙트·자동화) 변경은 재생 중 짧게 pause→load→play 재진입한다(01 §2 "그래프 수정은 정지 중 준비").
