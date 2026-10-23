# 0010 — 클라우드 동기화 구현 선택 (MVP-7, fake auth + 로컬 Workers/D1/R2)

- 상태: 로컬 구현 적용. 실제 공급자·도메인·예산은 미정(D07/D08) — 이 문서의 어떤 값도 실제 배포 설정으로 확정하지 않았다.

## 로컬 실행 환경
- **workerd/Miniflare 는 이 Pi 에서 실행 불가**: Raspberry Pi 4 커널(`6.18.50+rpt-rpi-v8`)이 `CONFIG_ARM64_VA_BITS=39` 이고 workerd 의 tcmalloc 이 48-bit 주소 공간을 가정해 시작 즉시 OOM(실측). 시스템 커널 교체는 하지 않았다.
- 대체: 같은 Worker 코드(`apps/api/src`)를 Node 에서 실행하고, 바인딩은 `apps/api/local/`의 어댑터로 제공한다.
  - D1 → `node:sqlite`(SQLite 3.53): `batch`=단일 transaction(실패 시 전체 rollback 후 throw), `meta.changes`, `?NNN`, bound parameter 100개 한도, await 경계(동시 요청 교차).
  - R2 → 메모리/디렉터리: head/get(range)/put/delete/list/multipart(complete 전에는 최종 key 없음).
- 실제 workerd 경로는 `apps/api/test/workerd.test.ts`(번들 `dist/worker.js` + Miniflare D1/R2)로 남겼고 CI(x86_64)에서만 실행된다. Pi 에서는 자동 skip(NOT-RUN).
- `wrangler` 는 설치하지 않았다(배포·로그인 불필요). `wrangler.toml` 은 placeholder 초안.

## 인증 경계
- `AuthAdapter.resolve(req) → {ownerId}`. 모든 API 는 세션의 ownerId 만 쓰고 요청 본문의 ownerId 는 읽지 않는다.
- 구현된 모드: `none`(기본, 인증 API 는 503 `AUTH_NOT_CONFIGURED`), `fake`(HMAC 토큰, `POST /v1/dev/login`).
- **fake auth production 방어**: (1) `ENVIRONMENT=development` 필수 (2) 요청 host 가 localhost/127.0.0.1/[::1] (3) `FAKE_AUTH_SECRET` 이 placeholder 가 아니고 16자 이상 — 하나라도 어기면 모든 요청 500 `CONFIG_REFUSED`. `wrangler.toml` 기본값은 `AUTH_MODE="none"`, `ENVIRONMENT="production"`; fake 값은 gitignore 된 `.dev.vars` 에만. 로컬 서버는 실행마다 무작위 secret 을 메모리에서 생성. 웹 production 빌드는 dev 로그인 모듈을 포함하지 않는다(`scripts/check-prod-bundle.mjs`, CI 단계).
- 세션은 `Authorization: Bearer` 로만 전달(쿠키 없음 → CSRF 대상 아님). 쿠키 세션 공급자를 고르면 SameSite + CSRF token + Origin 검사를 추가해야 한다. Origin allowlist(CORS)는 지금도 강제한다.

## 업로드
- **제한 URL = Worker 서명 URL**(R2 S3 presigned URL 아님): `PUT /v1/chunks/<token>`, 토큰은 upload·part·method·owner·만료(15분)를 HMAC 서명하고 인증 세션도 요구한다. S3 presign 은 R2 API 자격증명이 필요해 D07/D08 이후 선택 사항으로 남긴다. 업로드 바이트는 Worker 를 통과한다(Workers 요청 크기 한도 내 8MiB chunk).
- chunk 8MiB(실제 R2 multipart 는 마지막 외 5MiB 이상 필요 → development 가 아니면 5MiB 미만 거절), asset 1GiB·quota 1GiB·URL 15분·intent 24h 는 **제안값**(D08 승인 전).
- 검증: chunk 마다 서버 SHA-256(Workers 실행 한도 내), multipart complete 후 **전체 SHA-256 은 bounded incremental job**: 호출당 `VERIFY_BUDGET_BYTES`(기본 64MiB)만 range read, `Sha256` 상태(`exportState/fromState`)를 D1 `uploads.verify_state` 에 저장, 202 `verifying` 이면 같은 complete 호출로 재개. 서버 hash·길이가 맞을 때만 `objects.state='ready'`. snapshot 은 추가로 02 deserialize 검증 + project id 확인 + 참조 자산 목록을 서버가 추출(`objects.refs`). 클라이언트 hash 는 신뢰하지 않는다.
- 큰 파일 재개: 같은 owner/project/kind/hash 의 진행 중 intent 를 재사용해 누락 chunk URL 만 재발급.
- 중복 제거는 같은 계정·같은 project 안에서만(계정 간 존재 비노출).
- **미검증 사항**: 1GiB 급 파일의 실제 Workers CPU·시간·비용. 04 §5 에 따라 이 검증 전에는 큰 파일 동기화를 출시하지 않는다(D08).

## commit / CAS
- 순서: R2 업로드 → 서버 검증 ready → D1 `batch` 하나에서 [project 행(기대 head 가 null 일 때만 생성), revision 삽입, `UPDATE … WHERE head IS ?expected AND tombstoned_at IS NULL`, 실패 시 branch 행, idempotency 결과 행(갱신된 head 로 committed/conflict 결정), 결과 SELECT] → 응답.
- CAS 실패는 예외가 아니라 정의된 결과(`conflict` + `retainedRevision`)이며 candidate 는 `branches(reason='conflict')` 로 pin 보존. SQL transaction 실패는 503 `DB_ERROR`(상태 무변경, 같은 key 재시도) — 둘을 혼동하지 않는다.
- idempotency: 같은 key + 같은 payload hash → 저장된 결과 그대로, 다른 payload → 409. 동시 같은 key 는 UNIQUE 위반으로 뒤 batch 가 rollback 되고 먼저 저장된 결과를 돌려준다.
- commit 응답: committed/conflict 모두 200(본문 status). DELETE/restore 의 conflict 는 명세대로 409.
- DELETE = tombstone revision 을 CAS 로 head 에 올림(물리 삭제 없음, 30일 보존 제안). restore = 지정 revision(충돌 branch 포함)의 내용을 새 revision 으로 CAS.
- 서버 GC(cron): 만료 intent abort·미검증 객체 삭제, 어떤 revision(normal/tombstone/restore/branch)도 참조하지 않는 7일 지난 orphan 객체만 삭제. tombstone purge 는 **보고만**(MVP-7 범위에서 사용자 데이터 물리 삭제 제외).

## 클라이언트 (packages/storage)
- `RemoteApi` 인터페이스 주입(패키지는 네트워크를 import 하지 않음), fetch 구현은 `apps/web/src/sync/http-api.ts`.
- **outbox 는 로컬 commit 과 같은 IDB transaction** 에서 기록. 한 번도 전송하지 않은 queued 항목은 최신 revision 으로 대체(coalesce). 첫 전송 직전에 request(기대 remote head 포함)를 고정 저장하고 이후 재시도는 같은 key·payload 만.
- ack: `applySyncAck` 한 transaction 에서 remoteHead 갱신 + outbox 제거 = 동기화 성공. ack 이후 실패는 outbox 를 되살리지 않는다.
- 재시도 1/2/4/8/16/30/60초 상한 + ±20% jitter, 429 는 Retry-After, 401 은 auth-required(재로그인까지 대기, attempts 증가 없음).
- 계정별 outbox: 항목·연결에 ownerId. 다른 계정 세션에서는 전송·재연결하지 않는다. 로그아웃은 로컬 데이터·outbox 를 지우지 않는다.
- 최초 연결은 사용자 선택(`link`). 다른 기기 복원(`clone`)은 revision id 를 원격과 같게 유지하고 자산은 hash 재검증 후 import.
- 충돌 해결은 사용자 선택만: 로컬을 새 프로젝트로 보관 / 원격 사본 열기(로컬 분기 pin + 분기 목록) / 비교용 원격 사본 → 수동 병합 후 확인한 원격 head 위로 CAS. 원격 삭제 vs 로컬 편집: 로컬 자동 삭제 없음, "내 버전으로 복원" 또는 "로컬 전용 유지".
- 로컬 GC reachability 추가: conflict 기록의 local/remote/base/retained, 보존 분기.
- IDB 레코드 확장(`ProjectRecord.sync`, `syncStatus` 확장, meta `conflict:*`/`branches:*`)은 선택적 필드 추가이며 DB 버전·02 프로젝트 포맷 변경 없음.

## 편차·남은 일
- 업로드·해시는 메인 스레드의 async(WebCrypto) 경로에서 수행한다(명세의 worker 처리 권고와 다름). 재생·녹음 중에는 chunk 사이에서 멈추고 동시성 1. 대형 파일 실측 후 worker 이전을 검토.
- 실제 공급자·도메인·CORS origin·quota/보존 기간·비용은 D07/D08 선택 후 설정.
