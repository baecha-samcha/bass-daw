# 0006 — 리버브 분할 크기·작업 분산과 latency

- 상태: 적용 (MVP-5)
- 01 §6은 리버브를 "제한된 IR convolution"으로만 정의한다. 1초 stereo IR 의 균일 분할 overlap-save 에서
  - 분할 128: sample 당 complex MAC 약 375 → Pi 4 Node 에서 실시간의 약 0.35배(불가).
  - 분할 1024: MAC 은 충분히 줄지만 경계 block 에 FFT 4개 + 누산이 몰려 F02+M5 부하에서 128-frame block p99 가 예산의 177%(4.7ms/2.67ms).
- 결정:
  1. 분할 1024, 스펙트럼은 0..N/2 bin 만 Float32 로 저장(켤레 대칭).
  2. 경계 계산(FFT 단계·주파수 곱·IFFT 단계)을 작업 단위로 나눠 다음 분할 구간(1024 frame) 동안 고르게 수행.
  3. 그 결과 latency 는 2×1024 = 2048 frames(48kHz 42.7ms). `latencyFrames` 로 선언하고 01 §6 PDC 가 다른 경로를 보상, export 는 pre-roll 로 정확히 제거(A09), 녹음 배치 offset 에도 그래프 latency 를 더한다.
- 측정(F02+M5, 32 lane, Pi 4 Node, 128-frame block, 참고치): p99 4.73ms → 2.71(자동화 커서) → 1.96ms(작업 분산). 리버브 제외 시 1.30ms. 실제 기준 장치(Chromebook) 판정은 BLOCKED.
- 합산 순서가 block 크기와 무관하므로 37/128/512 frame block 결과가 bit 단위로 같다(테스트).
- 영향: 리버브가 있는 프로젝트는 실시간 출력 전체가 42.7ms 늦게 들린다(모니터링 지연). 저장 포맷 변화 없음.
- 후속: 비균일 분할로 latency 를 줄이는 안은 Chromebook 계측 후 검토.
