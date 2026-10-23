# MVP-7 보고서 — 인증·클라우드 동기화·충돌 복구 (fake auth + 로컬 Workers/D1/R2)

작성 2026-10-23 · 환경: Raspberry Pi 4B/8GB (aarch64, 커널 6.18.50+rpt-rpi-v8), Node v24.21.0, pnpm 10.34.7, 시스템 Chromium 154(headless)

## 판정 요약

| 구분 | 상태 |
|---|---|
| 로컬 구현(코드) | **완료** — auth 경계·fake auth·D1 스키마·R2 객체·업로드 intent/서명 URL/서버 검증/재개·head CAS·idempotency·재시도·충돌 분기·tombstone/restore·계정별 접근 제어·outbox·충돌 UI |
| 자동 테스트(fake auth + 로컬 D1/R2 어댑터, Node/headless Chromium) | **PASS** — C01–C07, L01–L05 회귀 포함 |
| 실제 workerd 런타임 테스트 | **NOT-RUN(Pi)** — 커널 39-bit VA 로 workerd 시작 불가. CI(x86_64)용 테스트만 준비 |
| 실제 로그인 공급자·staging·Cloudflare 리소스 | **BLOCKED** — D07(공급자·도메인)/D08(예산·한도·보존) 미선택. 계정·D1·R2·배포 생성하지 않음 |
| 실제 기기(Chromebook/모바일) 두 기기 동기화 | **BLOCKED** — 기기 미접근. Pi headless 의 두 persistent profile 로만 검증 |

다음 단계(MVP-8) 진입: 로컬 구현 기준으로는 가능. 단 실제 클라우드 연동 판정은 D07/D08 선택과 staging 검증 전까지 미완료로 남는다.

## 1. 구현된 사용자 흐름과 변경 파일

흐름: 로그인 없이 로컬 편집 → (개발용) 로그인 → 사용자가 "클라우드 연결" 선택 → 자동 업로드/커밋 → 다른 기기에서 "이 기기로 복원" → 오프라인 편집 → 재접속 시 한 쪽 성공·다른 쪽 충돌 → 충돌 패널에서 비교 후 선택(로컬을 새 프로젝트로 보관 / 원격 사본 열기 / 비교용 원격 사본 + 수동 병합 완료) → 로컬 분기는 "보존된 분기"에 남음. 클라우드 사본 삭제(tombstone), 원격 삭제 표시·복원, 로그아웃(로컬 보존), 계정 전환(이전 계정 outbox 미전송).

| 경로 | 내용 |
|---|---|
| `apps/api/src/{env,http,auth,app,index}.ts` | Worker: 설정 검증(fake auth 방어), CORS/Origin, 인증 adapter, rate limit, 프로젝트·업로드·commit·branch·delete·restore·blob·GC |
| `apps/api/migrations/0001_init.sql` | D1: owners/projects/revisions/branches/objects/uploads/idempotency/tombstones/rate (JSON 본문 없음) |
| `apps/api/local/{d1,r2,env,server}.ts` | node:sqlite D1 어댑터, 메모리/디렉터리 R2 어댑터, 로컬 개발 서버 |
| `apps/api/scripts/build.mjs` | esbuild 번들: `dist/worker.js`(배포 산출물 후보, 배포 안 함), `dist/local-server.mjs` |
| `apps/api/wrangler.toml`, `.dev.vars.example` | placeholder 만(AUTH_MODE="none", ENVIRONMENT="production") |
| `apps/api/test/{api,sync,workerd}.test.ts`, `helpers.ts` | API 18건, 2-client 19건, workerd 1건(조건부) |
| `packages/storage/src/sync.ts` | `SyncEngine`, `RemoteApi` 계약, backoff |
| `packages/storage/src/local-store.ts` | commit tx 안 outbox, link/unlink, ack/conflict tx, adoptRevision, 분기, GC reachability, lease 만료 의미 변경 |
| `packages/schemas/src/sha256.ts` | `Sha256.exportState/fromState`(재개 가능한 서버 검증) |
| `apps/web/src/sync/{cloud,http-api,dev-auth}.ts`, `ui/Cloud.tsx`, `ui/DevLogin.tsx` | 계정 카드·클라우드 목록·동기화 칩·동기화/충돌 패널·분기 목록. dev 로그인은 production 빌드에서 제외 |
| `apps/web/src/store.ts`, `ui/{Home,Editor}.tsx`, `App.tsx` | 연결 지점 |
| `scripts/check-prod-bundle.mjs`, `scripts/build-e2e.mjs` | production 번들 검사(fake auth·e2e hash·로컬 API 주소 없음), e2e 전용 빌드 |
| `playwright.config.ts`, `tests/e2e/m7-sync.spec.ts` | 로컬 API 서버 webServer, 데모·로그아웃 e2e |
| MVP-6 보강 | `plugin-api` ReviewPolicy, `audio-engine` WasmModuleCache, worklet prepareWasm, Web Lock 순서 — `MVP-6-report.md` 추가 절 참조 |

## 2. 설치·실행·검증 명령 (모두 이 Pi 에서 실제 실행)

```bash
pnpm install                      # 추가: apps/api devDeps miniflare 4.20260730.0, esbuild 0.28.2 (workerd 1.20260730.1 동반)
pnpm typecheck                    # 통과
pnpm test                         # 15 files: 165 passed, 3 skipped (perf 2, workerd 1)
pnpm test:e2e                     # 23 passed (6.8m), worker 1 — vite preview :4173 + 로컬 API :8787 자동 기동
pnpm build && node scripts/check-prod-bundle.mjs   # production bundle check OK
pnpm dev:api                      # 로컬 API http://localhost:8787 (state: tests/artifacts/api-state)
pnpm dev                          # 웹 http://localhost:5173 (.env.development 의 VITE_API_BASE 사용)
```

접속: 같은 Pi 의 브라우저에서 `http://localhost:5173`. fake auth 는 localhost 에서만 동작하므로 Chromebook 원격 접속에서는 로그인 UI 가 동작하지 않는다(의도된 제한). 실제 기기 2대 시험에는 D07 의 공급자·도메인 또는 사용자가 고른 터널/staging 이 필요하다.

## 3. 수용 테스트

| ID | 결과 | 환경 | 근거·수치 |
|---|---|---|---|
| C01 | PASS | Node(fake-indexeddb 2기기) + headless 2 profile | `sync.test.ts` C01 3건: 동시 sync → 정확히 synced 1·conflict 1, 서버 head=승자, branch=패자 revision, 패자 로컬 head 불변, 새 프로젝트 보관/원격 열기/수동 병합(부모=확인한 원격 head). `api.test.ts` CAS 경쟁 20회(두 요청이 CAS 직전까지 진행하도록 barrier) 모두 1 성공. e2e 데모 통과(3회 연속) |
| C02 | PASS | Node | 경계별 crash 5단계(before-upload/after-upload/before-commit/after-commit-response/after-ack) 후 재시작 → 서버 revision 1개·branch 0·idempotency 1·R2 바이트 hash 일치·outbox 비움. commit 응답 유실 → 같은 key 재시도로 결과 재사용. 네트워크 실패 backoff 1000/2000/4000ms(jitter 고정), 429 Retry-After 준수. 서버 hash 불일치 → error 표시, 로컬 원본 불변, 재시도 성공 |
| C03 | PASS | Node + headless | 원격 삭제 vs 오프라인 편집 → conflict(remoteDeleted), 로컬 자동 삭제 없음, CAS 복원. 깨끗한 기기는 remote-deleted 표시만. 로그아웃 → auth-required·로컬/outbox 보존, 다른 계정 로그인 시 프로젝트·chunk 요청 0건·재연결 거부, 재로그인 후 완료. 세션 만료 → auth-required(attempts 0), 재로그인 후 중복 없음. 업로드/다운로드 URL 만료 → 재발급 후 성공. e2e 로그아웃 테스트 통과 |
| C04 | PASS | Node | 다른 계정으로 head/revision/branches/upload 상태/complete/branch 생성/delete/restore 전부 403·404, 서명 URL 탈취(다운로드·chunk PUT) 403, 세션 없는 URL 401, 다른 계정의 asset 참조 commit 은 REF_NOT_READY(존재 비노출), 같은 project id 는 계정별 분리 |
| C05 | PASS | Node | 미업로드·미완료(chunk 누락 409)·클라이언트 hash 거짓(서버 전체 SHA-256 불일치 422)·chunk 변조(422)·검증 job 도중 R2 변조(422, 미검증 객체 삭제)·assetHashes ≠ snapshot 참조(REVISION_MISMATCH)·잘못된 snapshot/다른 project id snapshot → 모두 ready/commit 불가 |
| C06 | PASS | Node | 로컬: 105 revision 후 GC 에서 outbox(전송 시도 중)·conflict·pin revision 과 그 자산, Undo(extraReachable)·녹음 journal 자산 유지, 비참조 자산만 삭제. 서버: normal/branch/tombstone 참조 객체 유지, 만료 intent abort, 7일 orphan 만 삭제, tombstone purge 는 보고만(purged 0) |
| C07 | PASS(headless) | headless Chromium | e2e 데모: 기기 B 를 오프라인으로 두고 새로고침(서비스워커 캐시로 실행) → 편집·저장·WAV 내보내기 성공, 이후 재접속 동기화. Pi 를 실제로 끈 상태와 Chromebook 실기는 BLOCKED |
| L01–L05 | PASS(회귀) | Node + headless | `storage.test.ts` 23건, e2e L01/L04/L04b/L05 |
| 증분 검증 | PASS | Node | 5×64KiB+123B 객체가 64KiB 예산으로 5회 202 후 ready, 각 단계 offset 이 D1 에 저장 |
| fake auth 방어 | PASS | Node + production 빌드 | production/staging/미설정 ENVIRONMENT·비-localhost·placeholder secret → 전 요청 CONFIG_REFUSED, AUTH_MODE=none → login 404·API 503, 다른 서버 토큰/위조/만료 401, wrangler.toml 기본값 검사, production 웹 번들 검사 |
| workerd 런타임 | NOT-RUN | Pi | `workerd.test.ts` skip(이유 기록). CI 에서 실행 예정 — 결과 없음 |
| 실제 공급자·staging | BLOCKED | — | D07/D08 |

로그: `tests/artifacts/e2e-results.json`(Playwright), Vitest 콘솔 출력.

참고 — 테스트 검증: CAS 조건을 일부러 깨면 5건, idempotency 조회를 빼면 1건이 실패하는 것을 확인 후 원복했다(테스트가 해당 결함을 잡는지 확인).

## 4. 데이터 포맷·API·의존성 변경과 결정

- 02 프로젝트 포맷 변경 없음. IndexedDB 버전 변경 없음 — `ProjectRecord` 에 선택 필드 `sync`, `syncStatus` 값 확장, outbox 항목 구조, meta `conflict:<id>`/`branches:<id>` 추가.
- 공개 API: `docs/decisions/0010-cloud-sync.md` 및 04 §5 표의 엔드포인트 + `GET /v1/health`, `GET /v1/config`, `GET …/uploads/:id`(재개), `PUT /v1/chunks/:token`, `GET /v1/blobs/:token`, `GET …/branches`, 개발 전용 `POST /v1/dev/login`·`/v1/dev/gc`.
- 동작 변경: 만료된 탭 lease 를 자동으로 가져오지 않는다(`WRITER_UNRESPONSIVE`). 종료 증거(Web Lock 해제)나 사용자 takeover 가 필요.
- 의존성: `apps/api` devDeps `miniflare@4.20260730.0`, `esbuild@0.28.2`. 런타임 의존성 추가 없음(Worker 는 `@bass-daw/schemas` 만 번들).
- 결정 기록: `0010-cloud-sync.md`(로컬 환경·인증 방어·서명 URL·검증 job·CAS·클라이언트), `0009-plugin-host.md` 보강.

## 5. 미해결·사용자 선택·실기 확인 절차

실제 리소스 생성·배포 직전에 필요한 선택(임의 확정하지 않음):

| # | 선택 | 영향 |
|---|---|---|
| D07-a | 로그인 공급자(예: OIDC 계열 중 무엇) 와 세션 방식(Bearer vs 쿠키) | `AuthAdapter` 구현, 쿠키면 CSRF token 추가 |
| D07-b | 앱 도메인·API 도메인(플러그인 UI 별도 origin 포함) | CORS allowlist, 플러그인 UI 별도 origin 수용 기준 |
| D08-a | 계정당 저장 quota, asset 최대 크기(제안 1GiB), chunk 크기 | `QUOTA_BYTES`, `MAX_ASSET_BYTES`; 1GiB 유지 시 대형 파일 검증 job 의 실제 CPU·비용 측정 필요 |
| D08-b | tombstone 보존 기간(제안 30일)·충돌 분기 보존·purge 정책 | purge 구현 여부 |
| D08-c | 월 예산 상한, rate limit(제안 600/분) | Workers/D1/R2 플랜 |
| 운영 | Cloudflare 계정·D1·R2 private bucket·secret 등록·staging 환경 생성 주체 | `wrangler.toml` placeholder 교체, `wrangler secret put SIGNING_SECRET` |

미해결:
- workerd 런타임에서의 실행 결과 없음(Pi 커널 제약) — CI 또는 x86/48-bit VA 장비에서 `pnpm vitest run apps/api/test/workerd.test.ts`.
- 업로드·hash 는 메인 스레드 async 경로(worker 아님). 대형 파일·저사양 기기 실측 전.
- 원격 변경 감지는 15초 polling(열린 프로젝트) — 실시간 푸시 없음(범위 외).
- 1GiB 급 실제 업로드/검증 시간·비용 미측정.

실제 기기 확인 절차(공급자·도메인 결정 후, 또는 사용자가 고른 HTTPS 터널 + 임시 staging):
1. 기기 1(Chromebook)에서 프로젝트 생성·편집 → 로그인 → 홈의 "클라우드 연결" → 칩이 "동기화됨".
2. 기기 2(모바일)에서 같은 계정 로그인 → "이 기기로 복원" → 열어서 내용 확인.
3. 두 기기 모두 비행기 모드 → 각각 다른 수정·저장 → 기기 1 먼저 온라인 → "지금 동기화" → 기기 2 온라인 → "충돌" 표시 확인.
4. 기기 2 동기화 탭에서 비교표 확인 → "원격 사본 열기" → "보존된 분기"의 "새 프로젝트로 열기"로 자기 작업이 남아 있는지 확인.
5. 기기 1 "클라우드 사본 삭제" → 기기 2 에 "클라우드에서 삭제됨" 표시·로컬 보존 확인 → "클라우드 복원".

## 6. 데모 재현 (Pi 에서 실행)

자동: `pnpm exec playwright test tests/e2e/m7-sync.spec.ts`

수동:
```bash
pnpm dev:api        # 터미널 1
pnpm dev            # 터미널 2 → 브라우저 창 2개를 서로 다른 프로필(또는 일반+시크릿)로 http://localhost:5173
```
1. 창 A: 제목 입력 → "새 프로젝트" → "+ Bass" → "◀"(프로젝트 목록).
2. 창 A: "개발용 사용자"에 같은 이름 → "개발용 로그인(fake)" → 프로젝트 행의 "클라우드 연결" → "동기화됨".
3. 창 B: 같은 이름으로 로그인 → 클라우드 프로젝트 행의 "이 기기로 복원" → "열기".
4. 두 창을 오프라인(DevTools Network → Offline)으로 두고 각각 제목/트랙을 다르게 수정 → "저장".
5. 창 A 온라인 → "동기화" 탭 → "지금 동기화"(동기화됨). 창 B 온라인 → "지금 동기화" → "충돌".
6. 창 B 충돌 패널에서 로컬/원격 비교 확인 → "원격 사본 열기" → "보존된 분기"에 B 작업이 남음 → "새 프로젝트로 열기".

## 7. 최종 판정

- **구현 완료**: 로컬 Workers 대체 환경(node:sqlite D1, 메모리/디렉터리 R2) + fake auth 에서 MVP-7 범위 전체, 자동 테스트 PASS.
- **실제 연동 미완료**: 실제 로그인 공급자, 도메인, Cloudflare D1/R2/Workers, staging, workerd 런타임 실행, 실제 기기 두 대 — BLOCKED/NOT-RUN. 이 항목들은 완료로 표시하지 않는다.
- 커밋·push·배포하지 않았다.

---

## 보강 (2026-10-23 2차 지시)

판정 유지: **로컬 프로토콜 구현 완료 / 실제 Cloudflare 런타임·서비스 연동 미완료**.

### 환경별 결과 (서로 대체하지 않음)

| 항목 | (a) Node 대체 환경: node:sqlite D1 + 로컬 R2, 같은 Worker 코드 | (b) 실제 workerd(Miniflare D1/R2 시뮬레이터) | (c) 실제 Cloudflare 서비스(Workers/D1/R2) |
|---|---|---|---|
| fake auth production 거절 | PASS | NOT-RUN | BLOCKED |
| C04 인가(서명 URL 포함) | PASS | NOT-RUN | BLOCKED |
| C05 미검증/불일치 참조 거절 | PASS | NOT-RUN | BLOCKED |
| 검증 객체 고정(etag) | PASS | NOT-RUN | BLOCKED |
| 같은 hash 업로드 key 분리 | PASS | NOT-RUN | BLOCKED |
| CAS 경쟁·idempotency | PASS | NOT-RUN | BLOCKED |
| tombstone/restore | PASS | NOT-RUN | BLOCKED |
| C01–C03, C06(2-client) | PASS | 해당 스위트 없음(HTTP 계약만 이식) | BLOCKED |
| 실제 로그인 공급자 | — | — | BLOCKED(D07) |

(a)는 `apps/api/test/{api,sync,contract-node}.test.ts` 46건 통과, (b)는 같은 `contract.ts` 7건을 `workerd.test.ts` 가 실행하도록 준비만 됨.

### 1. x86 workerd 테스트 준비
- `apps/api/test/contract.ts`: 런타임 무관 HTTP 계약 스위트(7건). Node 대체(`contract-node.test.ts`)와 workerd(`workerd.test.ts`, 번들 `dist/worker.js` + Miniflare)가 같은 스위트를 실행한다.
- `.github/workflows/ci.yml` 에 `workerd-contract` job 추가(ubuntu-latest, workerd `--version` smoke, `REQUIRE_WORKERD=1` 이면 workerd 가 없을 때 skip 대신 실패, 결과 JSON artifact). 외부 계정·secret·배포 없음. YAML 은 파서로 구조만 확인했다.
- **BLOCKED**: push 하지 않았으므로 Actions 실행 결과가 없다. 이 Pi 에서는 커널 39-bit VA 로 workerd 실행 불가, docker 소켓 권한 없음, x86 에뮬레이션(qemu binfmt) 없음. `REQUIRE_WORKERD=1` 로컬 실행 시 의도대로 실패하는 것만 확인했다.

### 2. 업로드 해시 전용 Web Worker
- `apps/web/src/workers/hash.worker.ts` + `apps/web/src/sync/hasher.ts`, `SyncEngine({ hasher })` 로 주입(`packages/storage` 기본 구현 `streamHasher` 는 Node/테스트용).
- bounded streaming: Blob 은 참조 전달, `slice(chunk).arrayBuffer()` 로 chunk 하나씩. 취소(AbortSignal → `CANCELLED`, 엔진은 backoff·자동 재시작 없이 대기), 오류 전달(`HASH_ERROR`/`READ_ERROR`), worker 사망 시 새 worker 로 1회 재시도.
- 측정(Pi headless Chromium, `tests/e2e/m7-hash-worker.spec.ts`): 128MiB 를 8MiB chunk 로 해시 → node:crypto 오라클과 전체·chunk hash 일치, 보유 버퍼 최대 8MiB, 작업 중 worker heap 약 8.7MB(`measureUserAgentSpecificMemory`), **메인 스레드 long task 0건**. 대조군(같은 해시를 메인 스레드에서 16MiB) long task 318ms·299ms. 처리량 약 23MiB/s(1GiB ≈ 45초, Pi 기준 — Chromebook 실측 필요). 취소·오류·crash→재시작 후 같은 결과 PASS.

### 3. 서명 URL 검증 점검 → `docs/decisions/0011` §1
- 서명 URL 은 R2 presigned 가 아니라 Worker 경로이며, 다른 사용자 차단은 Worker 의 세션 인증(L1)과 토큰 owner = 세션 owner 검사(L3)에서 일어난다. R2 key 는 토큰이 아니라 owner 범위 D1 조회로 얻는다.
- 로컬 대체 서버와 실제 경로의 차이(바인딩·런타임)와, 동등성이 "R2 private bucket·public access 없음" 배포 설정에 달려 있음을 기록했다. R2 presigned URL 을 채택하면 URL 소지자 차단이 불가능(bearer)하므로 요구사항을 다시 정해야 한다.
- 따라서 C04 는 (a) PASS 만 확인됐고 배포 경로는 BLOCKED 로 둔다.

### 4. 큰 파일 검증 중 객체 변경 → `docs/decisions/0011` §2
- 결함 수정: 같은 hash 재업로드가 같은 key 를 덮어쓸 수 있었고, 검증·다운로드가 "검증한 그 객체"인지 확인하지 않았다.
- 변경: 업로드별 고유 key, `complete()` etag 를 검증 상태에 저장하고 모든 range read·snapshot 파싱·다운로드를 `onlyIf.etagMatches` 로 고정, `objects.etag`(migration `0002_object_etag.sql`), 불일치 시 422/409 `OBJECT_CHANGED`, D1 에 없는 R2 key 7일 sweep.
- 테스트(a): 검증 도중 미검증 구간을 바꾼 새 버전으로 덮어쓰기 → 거절, ready 후 객체 변조 → 다운로드 409, 같은 hash 두 업로드 → key 1개만 남음.

### 변경 파일(보강)
`apps/api/src/{app,env,http}.ts`, `apps/api/migrations/0002_object_etag.sql`, `apps/api/local/{r2,env}.ts`, `apps/api/test/{contract,contract-node,workerd}.test.ts`·`contract.ts`, `.github/workflows/ci.yml`, `packages/storage/src/sync.ts`(ObjectHasher, cancel), `apps/web/src/{workers/hash.worker.ts,sync/hasher.ts,sync/cloud.ts,debug.ts}`, `tests/e2e/m7-hash-worker.spec.ts`.

### 재실행한 명령(이 Pi)
`pnpm typecheck` OK · `pnpm test` 173 passed / 9 skipped(perf 2, workerd 계약 7; 마지막에 추가한 migration 재시작 테스트 포함) · `pnpm test:e2e` 28 passed(8.9m) · `pnpm build && node scripts/check-prod-bundle.mjs` OK · `REQUIRE_WORKERD=1 pnpm vitest run apps/api/test/workerd.test.ts` → 의도대로 실패(workerd 없음).

추가 발견·수정: 로컬 D1 어댑터가 시작할 때마다 모든 migration 을 재실행해 `0002`(ALTER TABLE)가 두 번째 시작에서 실패할 수 있었다 → `d1_migrations` 표로 새 파일만 1회 적용(테스트 + 같은 state 로 서버 2회 재시작 확인). 0002 이전에 만든 로컬 state 의 ready 객체는 etag 가 없어 다운로드되지 않는다(개발 데이터만 해당, 재업로드 필요) — `docs/runbook.md` §4.
