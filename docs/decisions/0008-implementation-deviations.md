# 0008 — 구현 편의상 선택 (스택 변경 없음)

| 항목 | 명세 | 구현 | 근거/후속 |
|---|---|---|---|
| Performance Event 컴파일 위치 | 01 §2: worker | main thread (`engine.prepare`) | F02 10,000 노트 컴파일 131ms(Pi Node). 재생은 worker 큐 공급이라 영향 없음. 긴 곡 편집 시 UI 지연 가능 → 후속에서 worker 이전 |
| 원본/PCM 디코딩 | worker | WAV·파형은 worker, 압축 포맷은 main 의 `decodeAudioData`(브라우저 내부 스레드) | AudioContext API 는 worker 에 없음 |
| PWA | — | 플러그인 없이 직접 작성한 SW(hash 버전 shell) | 의존성 최소화, 업데이트 전환을 사용자 선택으로 제어 |
| 진단 dry capture(MVP-0) | — | ScriptProcessor 3초 | 진단 전용. 제품 녹음은 AudioWorklet capture |
| capture chunk 전달 | 할당 금지 | 2048 frame 마다 transferable 버퍼 1개 할당 | process 당 대량 할당 아님. SAB ring 이전은 후속 |
| Undo 메모리 | 64MiB 한도 | payload 크기 기반 근사(구조 공유) | 정확한 heap 측정 API 없음 |
| 검증 성능 | 16ms p95 | 검증 통과 source 객체 캐시(WeakSet) | 13.5ms p95 (Pi Node, 10k notes) |
| 선형 보간 resampler | high 품질은 계측 후 | 전 profile 선형 | 01 §6 최소 기능 |
