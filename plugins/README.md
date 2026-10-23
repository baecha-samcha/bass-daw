# 샘플 플러그인 (bass-daw-wasm-1)

`dsp.wat` 를 wabt 로 컴파일해 `.bdplugin`(ZIP: manifest.json, dsp.wasm, ui.html?) 번들을 만든다: `node scripts/build-plugins.mjs`.
manifest 의 `dsp.sha256`/`ui.sha256` 는 빌드가 채운다. 번들 hash(전체 ZIP SHA-256)는 설치 승인 hash 다.

공통 메모리 배치(maxBlockFrames 512): input c → 1024 + c·2048, output c → 5120 + c·2048, events → 9216(최대 1024×32B), params → 41984(parameterCount·512·4), heap ≥ 49152(gain/faultdemo) 또는 65536(oneshot).
