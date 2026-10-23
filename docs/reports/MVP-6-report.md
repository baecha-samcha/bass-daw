# MVP-6 보고서 — 웹 플러그인 호스트·WASM ABI

작성 2026-10-23 · 환경: Pi 4B Node v24.21.0, headless Chromium 154. 샘플 플러그인은 WAT → wabt 1.0.39(빌드 도구) 컴파일.

## 1. 구현된 사용자 흐름과 변경 파일

흐름: 편집기 → "플러그인" 탭 → "샘플 검사: …" 또는 "파일에서 검사(.bdplugin)" → manifest·번들 hash·권한·경고 확인 → "이 hash 를 승인하고 설치"(Worker 시험 렌더, 5초 watchdog) → 믹서에서 effect 추가 / 트랙 Instrument 선택(one-shot 은 프로젝트 오디오 자산을 사용자가 선택) → host 제공 파라미터 슬라이더, "UI"(sandbox iframe), "bypass" → 자동화 탭에서 플러그인 파라미터 lane → 저장/재시작 → 제거 시 "missing"(state·parameter·automation 보존, 재생 bypass, export 차단) → fault 시 "fault: trap" 배지와 보상된 dry bypass.

| 위치 | 내용 |
|---|---|
| `packages/plugin-api` (신규) | `wasm-binary.ts`(type/import/memory/export 정적 검사, ABI1 시그니처, host import allowlist), `manifest.ts`(03 §2 검증·unknown field 거절), `bundle.ts`(.bdplugin 검사·작성, hash 검증), `runtime.ts`(ABI1: create/configure/bind_sample/포인터 검증/planar PCM·이벤트 32B·파라미터 버퍼/subblock·1024 이벤트 분할/fault 감지), `conformance.ts`(P01 시험 렌더), `host.ts`(inspect/install/instantiate/setParameter/restore/bypass/dispose, 고정 hash 모듈 조회) |
| `packages/audio-engine` | `dsp/wasm.ts`(WasmEffectDsp: 보상 dry bypass 5ms 전환, WasmInstrumentDsp: 이벤트 큐·무음 fault), `plan.ts`(PluginResolver, WasmRef, latency/tail 반영, migration 불일치 진단), `core.ts`(모듈 맵, pluginFaults, setPluginBypass), `offline.ts`(export 에 플러그인·hash 기록) |
| `packages/project-core` | `InsertEffect.external`, `SetInstrument` 명령 |
| `packages/storage` | archive manifest 에 plugin hash |
| `plugins/{gain,oneshot,faultdemo}` | 샘플 플러그인(WAT, manifest, gain UI) · `scripts/build-plugins.mjs` → `apps/web/public/plugins/*.bdplugin` + index.json |
| `apps/web` | `plugins/registry.ts`(IDB meta + ByteStore, Worker 시험 렌더 watchdog), `workers/plugin-test.worker.ts`, `ui/Plugins.tsx`, `ui/PluginUi.tsx`(sandbox UI), Mixer/Automation/EnginePanel 연동, processor/engine/export worker 의 wasm 전달 |

샘플 번들 hash: gain `8d8c4276…649a`, oneshot `c0a5417e…8d64`, faultdemo `cc211c82…d4e4`(빌드 재현 시 동일; `node scripts/build-plugins.mjs`).

## 2. 명령

| 명령 | 실행 |
|---|---|
| `pnpm build`(플러그인 번들 + 앱) | ✅ |
| `pnpm typecheck` | ✅ |
| `pnpm test`(119 pass, perf 2 skip) | ✅ |
| `pnpm test:e2e`(18 시나리오) | ✅ |
| `PERF=1 pnpm vitest run tests/perf/plugins.perf.test.ts` | ✅ |

## 3. 수용 테스트

| ID | 결과 | 근거 |
|---|---|---|
| P01 | PASS | gain: 독립 기대값(out = in × gain, float32 정확 일치) block 1/37/128/512/600/4096, mono 입력 plugin, 적합성(유한·frame 수·block 크기 불변·impulse latency·tail). one-shot: velocity·피치 rate·sample 정확 offset |
| P02 | PASS | WASI import, export 시그니처 오류, memory max 없음/초과/shared, 번들 변조(hash), 경로 탈출, `builtin.*` 사칭, unknown field, default 범위 밖, maxMemoryPages 초과, 미허용 권한, 9MiB 번들, apiVersion 불일치, ABI version 불일치, 범위 밖 포인터, state 초과 → 거절. 승인 hash 불일치·같은 version 다른 hash(VERSION_CONFLICT)·범위 밖 파라미터 거절. 기존 설치 상태 불변 |
| P03 | PASS | trap/NaN → faulted, 이후 호출 중단. 렌더 그래프: block 경계에서 trap → 5ms 램프로 dry 복귀, 프로젝트 state 불변. 브라우저: "fault: trap" 표시·재생 계속·state 보존, processorerror 주입 → node 재생성 → paused |
| P04 | PASS(headless Chromium, 6/6 반복) | 악성 UI: fetch/img/sendBeacon 외부 서버 도착 0건, parent 접근·top 탐색·storage 차단, 위조 nonce·미지 파라미터·범위 밖·권한 없는 자산 요청·64KiB 초과·미지 타입·60개/초 초과 → 33건 거절, 다른 instance 파라미터 불변, 자기 파라미터 정상 변경만 반영 |
| P05 | PASS | 미설치/hash 불일치 plugin: state·parameter·automation round trip, export 기본 차단(Vitest + 브라우저 제거 후 EXPORT_BLOCKED) |
| P06 | PASS | 무한 루프 fixture 를 Node worker_thread 에서 실행 → 5초 watchdog terminate, runner 생존. **제품의 실시간 강제 중단 보장이 아님**(같은 오디오 스레드의 무한 루프는 멈출 수 없음) |
| A08/A09/X03 회귀 | PASS | 전체 스위트 |
| MVP-6 데모 | PASS(headless) | 설치 → gain+one-shot → 자동화 → 재시작 → 제거 시 missing 보존·export 차단 → fault bypass → processorerror 복구 |

플러그인별 예산(Pi 4 Node 참고치, 128-frame block 예산 2.67ms, `tests/artifacts/perf/plugins.json`): gain p99 0.020ms(0.7%), one-shot(8 voice) p99 0.039ms(1.5%), faultdemo p99 0.032ms(1.2%). 메모리 gain/faultdemo 64KiB, one-shot 8MiB(고정 최대). 03 목표(plugin 당 p99 ≤ 20%)는 Pi 에서 충족, 실기 BLOCKED.

## 4. 결정·포맷

decisions 0009. 영속 포맷 변화: 없음(외부 plugin 은 기존 `PluginInstance`, hash 는 `metadata["pluginHash:<id>@<ver>"]`). 새 개발 의존성: wabt 1.0.39(샘플 빌드·테스트 전용, 런타임 미포함).

## 5. 이번 작업에서 발견·수정한 결함

- 새 트랙의 믹서 채널 이름이 "midi" 등 종류명으로 생성됨 → 트랙 이름과 동일하게 수정.
- 브라우저를 닫은 직후 다시 열면 이전 탭 lease(TTL 10s) 때문에 읽기 전용으로 열림 → lease 를 가진 동안 Web Lock 을 쥐고, lock 이 비어 있으면 죽은 writer 로 보고 자동 takeover(L04 회귀 통과).
- Chromium 이 WebAssembly.Module 을 AudioWorklet 으로 보내지 않음, 그래프에 Module 이 섞이면 load 메시지 전체가 조용히 폐기 → 바이트 전송·직렬화 필드 제한·messageerror 진단.

## 6. 미해결·사용자 선택

- 별도 origin UI 호스팅(전용 도메인 + HTTP CSP)은 D07 결정 필요. 현재는 opaque origin + meta CSP.
- 서드파티 DSP 정책(D05): 검토·고정 hash WASM 만 허용, 임의 JS DSP 없음. 무한 루프·CPU 초과는 실시간에서 격리되지 않음 — 외부 DSP 공개 출시 여부는 사용자 결정 사항.
- state migration 함수 체계는 미구현(불일치 시 bypass).
- 실기: Chromebook 에서 플러그인 탭 → 샘플 3개 설치 → 믹서에 gain, Keys instrument 를 one-shot 으로 → 재생 → 엔진 진단의 block time·plugin faults 기록.

## 7. 판정

코드 완료 ✅, 자동 테스트 P01–P06 ✅(headless/Node), 실기 BLOCKED. MVP-7(클라우드)은 별도 실행 지시와 D07/D08 선택을 기다린다.


---

## 추가 확인 (2026-10-23, MVP-7 착수 전 지시)

판정 유지: **코드·Pi 자동 테스트 완료 / 실제 기기 검증 미완료 / 별도 origin UI 수용 기준 미완료(D07 대기)**.

| 항목 | 결과 | 근거 |
|---|---|---|
| 1. 외부 DSP = 검토된 고정 hash 만, 로컬 번들 우회 없음 | PASS(Node+headless) | `packages/plugin-api/test/plugin.test.ts` D05 3건(사용자 승인 로컬 번들 거절·시험 렌더 0회, 목록 밖 설치본 미실행, 배포 목록 = 빌드 산출물 hash), `tests/e2e/m6-plugins.spec.ts` "D05"(UI 버튼 비활성 + `host.install` 직접 호출도 `PLUGIN_NOT_REVIEWED`). 공개 업로드·마켓 없음 |
| 2. WASM 컴파일은 준비 단계에서만 | PASS(Node+headless) | `packages/audio-engine/test/plugins.test.ts` "item 2" 3건(재생/시작 중 거절, 실제 WorkletRuntime 상태로 판정, RenderCore 생성+500 블록 동안 컴파일 API 호출 0회, 미준비 모듈 보상 bypass), e2e "item 2"(재생 중 effect 삽입 → 컴파일 기록 전부 `transport=idle`, 재생 중 직접 요청 거절, fault 0) |
| 3. takeover 후 stale epoch/head 거절, 응답 지연 ≠ 종료 | PASS(Node+headless) | 저장소: 만료 lease 는 `WRITER_UNRESPONSIVE`(자동 획득 안 함), 정상 release 만 즉시 획득, takeover 후 이전 탭의 stale epoch(현재/과거 head)·heartbeat·재획득 거절, 재-takeover 후 stale head 는 `LOCAL_HEAD_CHANGED`. 앱: Web Lock 을 lease 보다 먼저 획득, lock 이 다른 탭에 있으면 lease 만료여도 read-only, 명시적 takeover 는 lock steal(이전 탭 즉시 read-only). e2e L04b: CDP 로 탭 A 를 12초 freeze(lease 만료) → B 는 read-only, A 는 깨어나 저장 성공 → B takeover → A 의 내부 commit 직접 호출도 `WRITER_LOST` |
| 4. sandbox UI | 임시 구성으로 기록(decisions/0009). 별도 origin 수용 기준 **미완료(BLOCKED: D07 도메인)** | — |

동작 변경: Web Locks 가 없는 브라우저에서는 크래시한 탭의 lease 가 남아 있으면 사용자가 "가져와 편집"을 눌러야 한다(이전에는 10초 후 자동 획득).
