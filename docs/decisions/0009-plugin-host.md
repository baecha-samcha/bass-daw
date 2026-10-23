# 0009 — 웹 플러그인 호스트 구현 선택 (MVP-6)

- 상태: 적용
- **패키지**: `packages/plugin-api` 신설. 근거: manifest/번들/WASM 정적 검사·적합성은 main thread(설치), Worker(시험 렌더), Node(테스트·watchdog)에서, ABI 런타임은 AudioWorklet 에서 공통으로 쓰이며 audio-engine 이 의존한다.
- **번들 포맷**(03 미정의): `.bdplugin` = ZIP { manifest.json, <dsp.path>.wasm, <ui.path>.html? }. 그 외 파일·하위 경로 거절, 8MiB/압축해제 32MiB 한도. 번들 전체 SHA-256 = 설치 승인 hash. dsp/ui 는 manifest sha256 과 일치해야 함.
- **ABI 시그니처 확정**(03 은 "number"만 표기): `create(f32 sampleRate, i32 maxFrames)->i32`, `bind_sample(i32,i32,i32,i32,i32,f32 sampleRate)->i32`, 나머지 i32. 바이너리 type/function/export section 을 직접 읽어 검사.
- **import allowlist**: `host.{sin,cos,tan,exp,log,tanh,sqrt}(f64)->f64`, `host.pow(f64,f64)->f64` 만. 메모리는 자체 정의 1개·비공유·max 필수(≤ manifest.maxMemoryPages ≤ 1024). 시작 전 max 까지 grow 해 재생 중 memory.grow 는 항상 실패, 그래도 크기 변화 감지 시 fault.
- **샘플 슬롯**: `PluginInstance.assets[i]` → slot i (host 소유 매핑).
- **버전·hash 고정**: `PluginInstance` 에 hash 필드가 없어 프로젝트 `metadata["pluginHash:<id>@<ver>"]` 에 번들 hash 를 고정한다(02 의 metadata 확장 허용 범위). 설치본 hash 가 다르면 미설치로 취급. archive manifest `plugins[].hash` 에 기록.
- **Worklet 전달**: Chromium 은 `WebAssembly.Module` 을 AudioWorklet 포트로 전달하지 않는다(오류 없이 메시지 폐기, 실측). 검증된 wasm 바이트를 보내 워클릿에서 컴파일한다. **(2026-10-23 보강)** 컴파일은 별도 `prepareWasm` 단계에서만, worklet transport 가 `idle` 일 때만 수행한다(`WasmModuleCache`, 재생/시작 중 요청은 `COMPILE_WHILE_PLAYING` 으로 거절·기록). 재생 중 그래프 변경은 pause ack 후 prepareWasm → load → 재개. `load`·RenderCore·Wasm*Dsp 는 컴파일하지 않으며, 준비 안 된 모듈은 `not-prepared`(effect=보상 dry, instrument=무음). 렌더 그래프에는 직렬화 가능한 필드만 담고(회귀 테스트), messageerror 를 진단으로 보고한다.
- **bypass**: 수동 bypass 는 runtime 전용(영속 아님). fault 시 effect 는 latency 만큼 지연된 dry 로 5ms 전환, instrument 는 무음, 자동 재시작 없음(재준비 시 재시도).
- **state migration**: v1 은 migration 함수 없음 → stateVersion 불일치는 bypass + 진단, 원본 state 보존.
- **UI**: sandbox iframe(`allow-scripts` 만, opaque origin) + srcdoc meta CSP(`connect-src/form-action/frame-src/worker-src 'none'`, `img-src data:`), nonce 가 있는 전용 MessageChannel, 64KiB·60개/초, 자기 파라미터·resize·(권한+사용자 선택 시) 자산 메타데이터 handle 만. COEP require-corp 문서 안에서 동작 확인.
  - SW 가 CSP 헤더로 UI 문서를 제공하는 안은 Chromium 이 opaque-origin sandbox iframe 탐색에 SW 를 쓰지 않아 기각.
  - 측정 주의: Playwright `page.route`/request 이벤트는 CSP 로 차단된 이미지 요청도 보고한다. 네트워크 차단은 브라우저 밖 서버에 실제 도착한 요청으로 판정한다(P04).
  - 명세의 "별도 origin" 호스팅(전용 도메인 + HTTP CSP 헤더)은 D07(도메인) 결정 후 적용. 현재는 opaque origin 으로 대체.
- **설치 시험 렌더**: Web Worker 에서 적합성 검사, 5초 watchdog 로 terminate. 이는 설치 단계의 무한 루프 탐지일 뿐 실시간 격리 보장이 아니다.

## 2026-10-23 보강 (사용자 지시)

- **D05 정책 = 검토된 고정 hash 만**: `PluginHost` 는 `ReviewPolicy` 를 필수로 받는다. 앱 정책은 빌드 시점에 박힌 `apps/web/src/plugins/reviewed.json`(저장소 리뷰를 거친 `plugins/*` 의 `pluginId@version#bundleSha256`, `scripts/build-plugins.mjs` 가 생성)뿐이다. 런타임 fetch·사용자 추가 경로 없음. 사용자 승인은 필요조건일 뿐이며, "파일에서 검사"로 고른 로컬 번들도 목록에 없으면 `PLUGIN_NOT_REVIEWED`(시험 렌더 전 거절, UI 설치 버튼 비활성). 이미 설치된 항목도 목록에 없으면 `module()`/`installedBundle()` 이 null → 실행 안 함. 공개 업로드·플러그인 마켓 없음.
- e2e 의 악성 UI 번들(P04)은 `vite build --mode e2e` 에서만 `VITE_E2E_REVIEWED` 로 추가된다(`scripts/build-e2e.mjs`). production 빌드는 이 값을 읽지 않으며 `scripts/check-prod-bundle.mjs` 가 산출물에 e2e hash 가 없음을 확인한다. e2e 산출물은 배포하지 않는다.
- **sandbox UI 는 임시 구성**: opaque-origin sandbox iframe + meta CSP 는 별도 origin 수용 기준의 대체물이 아니다. 03 의 "별도 origin(전용 도메인 + HTTP CSP 헤더)" 수용 기준은 **미완료**로 유지하며 D07(도메인) 선택 전에는 완료 처리하지 않는다.
