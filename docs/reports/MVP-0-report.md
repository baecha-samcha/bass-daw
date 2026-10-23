# MVP-0 보고서 — 개발 환경 및 브라우저 위험 검증

작성 2026-10-23 · 실행 환경: Raspberry Pi 4B / 8GB / SSD(`/srv/storage`), Debian 13, Node v24.21.0, pnpm 10.34.7(corepack), Chromium 154.0.8037.57(시스템) · 저장소: `bass-daw/` (새로 생성, git init, **커밋하지 않음**)

## 1. 구현된 사용자 흐름과 변경 파일

- 진단 페이지 `#/diagnostics` (`apps/web/src/diagnostics/Diagnostics.tsx`) — 제품 기능과 분리, 진단 데이터(`diag/*`)만 정리.
  1. 기능 탐지: secure context, crossOriginIsolated, SAB, AudioContext/AudioWorklet, IndexedDB, OPFS(getDirectory/createWritable/worker SyncAccessHandle), Web Locks, BroadcastChannel, getUserMedia, Service Worker, a[download], 저장 quota/persisted, 코어 수·deviceMemory.
  2. 사용자 gesture 후 컨텍스트 시작(48kHz 요청 → 실제 rate 표시), 재생/일시정지/suspend/resume, 진단용 impulse/sampler(실제 제품 엔진 큐 경로 사용).
  3. 재생 중 main thread 100/500ms 정지 주입(진단 전용 버튼) → late/underrun 변화 기록.
  4. 128MiB 결정적 자산 생성→SHA-256→OPFS 저장→재검증, 브라우저 재시작 후 "재시작 후 복구 확인", IDB Blob fallback 강제, 진단 데이터만 정리.
  5. 마이크 dry capture 3초(echoCancellation/noiseSuppression/autoGainControl=false 요청, 실제 settings 표시) + WAV 다운로드.
  6. 기기 정보 입력 양식 + JSON 보고서 다운로드.
- `scripts/probe-env.mjs` → `docs/reports/env-probe.json`(Node/pnpm/OS/arch/메모리/디스크/Chromium/git).
- 최소 Vite 앱에 COOP/COEP/CORP 헤더(dev/preview), `pnpm dev:https`(자체 서명, `@vitejs/plugin-basic-ssl`).

## 2. 재현 명령 (실행 완료 표시는 이번 작업에서 실제 실행한 것)

| 명령 | 실행 |
|---|---|
| `node scripts/probe-env.mjs` | ✅ |
| `pnpm install` | ✅ |
| `pnpm build && pnpm preview` (http://<pi>:4173) | ✅ |
| `pnpm dev:https` → `https://192.168.0.227:5173/#/diagnostics` (LAN) | ✅ 서버 기동·헤더 확인(curl). Chromebook 접속은 ❌ 미실행 |
| `pnpm test:e2e -- tests/e2e/m0-diagnostics.spec.ts tests/e2e/smoke.spec.ts` | ✅ (headless Chromium, Pi) |

Chromebook 확인 절차(사용자 실행): Pi 에서 `pnpm dev:https` → Chromebook Chrome 에서 `https://<pi-ip>:5173/#/diagnostics` → 인증서 경고 "고급 → 계속" → ① 기능 탐지 확인 ② "컨텍스트 시작" ③ "재생" 후 100ms/500ms 정지 버튼 ④ "저장 테스트" → Chrome 완전 종료 → 다시 열고 "재시작 후 복구 확인" ⑤ "권한 요청 후 3초 녹음" → WAV 다운로드 ⑥ 기기 정보 입력 → "JSON 보고서 다운로드". 자체 서명 인증서에서 Service Worker 는 등록되지 않을 수 있다(secure context 와 별개) — 그 경우 B01 실기 확인은 신뢰된 HTTPS(터널/사설 CA) 선택 후 수행. 포트 공개·터널 계정은 만들지 않았다.

## 3. 결과

| 항목 | 결과 | 환경·수치 |
|---|---|---|
| 개발 환경 조사 | PASS | Pi4B 4코어, 7.64GiB, SSD 77G 여유, root 아님 (`docs/reports/env-probe.json`) |
| 기능 탐지(headless Chromium 154, Pi, http://localhost) | PASS | secureContext/crossOriginIsolated/SAB/AudioWorklet/OPFS/createWritable/SyncAccessHandle/WebLocks/getUserMedia/SW 모두 true, quota 10GiB, persisted=false |
| 48kHz 요청 → 실제 rate | PASS(headless) | 48000 |
| 128MiB 저장→hash→브라우저 재시작→복구 | PASS(headless) | OPFS 쓰기 6.5s, 재검증 4.8s, 재시작 후 동일 hash `6d2138…` |
| OPFS 불가 fallback(IDB Blob 강제) | PASS(headless) | 동일 hash 검증 |
| UI 100/500ms 정지 중 late/underrun | PASS(headless) | late Δ0, underrun Δ0 (큐 공급이 worker 라 main 정지 영향 없음) |
| dry capture | PASS(fake device) | 2.99s, 48kHz |
| JSON 보고서 | PASS | `tests/artifacts/diag-report-headless.json` |
| **Chromebook 실기 전체** | **BLOCKED** | 기기 접근 없음 |
| **Android/iOS 실기** | **BLOCKED** | 기기 미확정(D07) |
| 실제 출력 끊김(loopback) | BLOCKED | 장비 없음 |

## 4. 데이터 포맷·API·의존성

- 의존성(lockfile `pnpm-lock.yaml`): react 19.3.1, react-dom 19.3.1, zustand 5.0.16, typescript 7.0.2, vite 8.3.5, @vitejs/plugin-react 6.1.2, @vitejs/plugin-basic-ssl 2.3.0, vitest 5.0.5, @playwright/test 1.64.1(시스템 Chromium 사용, 브라우저 다운로드 없음), fake-indexeddb 6.2.6, fflate 0.8.3.
- 진단 데이터는 제품 프로젝트와 별도 경로(`diag/…`, IDB `bass-daw-diag`).

## 5. 미해결·사용자 선택

- D07: Chromebook 원격 HTTPS 방식(자체 서명 vs 터널 vs 사설 CA), 실제 Android/iOS 기기 모델 확정 필요.
- 자체 서명 인증서에서는 SW 가 거부될 수 있어 PWA 실기 검증에는 신뢰된 인증서가 필요.

## 6. 판정

- 코드 완료: ✅ 진단 도구·자동 검증 완료.
- 실제 기기 검증: ❌ BLOCKED (Chromebook·모바일·loopback).
- 다음 단계: 사용자 지시에 따라 MVP-1~5 를 이어서 구현했다(각 보고서 참조). 실기 결과가 나오면 profile·lookahead(현재 250ms/25ms, 시작 lead 100ms) 재조정 필요.
