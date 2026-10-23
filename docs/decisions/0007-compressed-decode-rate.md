# 0007 — 압축 포맷 디코딩 rate

- 상태: 적용 (MVP-4)
- WAV 는 자체 디코더(worker)로 원본 sampleRate·frame 수를 그대로 얻는다. MP3/OGG/FLAC/M4A 등은 브라우저 `decodeAudioData` 를 써야 하는데, 이 API 는 컨텍스트 rate 로 resample 하며 원본 rate 를 알려주지 않는다.
- 결정: 압축 포맷은 48kHz OfflineAudioContext 로 디코딩하고 `Asset.audio` 메타데이터를 그 디코딩 결과(48k)로 기록한다(02 §6 "audio 메타데이터는 디코딩 결과"). 원본 바이트·SHA 는 그대로 보존.
- 영향: 같은 압축 파일을 다른 브라우저에서 디코딩하면 frame 수가 미세하게 다를 수 있다. 클립 선택 범위는 frameCount 로 clamp 된다. 정밀 편집에는 WAV 를 권장한다.
