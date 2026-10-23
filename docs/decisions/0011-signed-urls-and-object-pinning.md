# 0011 — 서명 URL 인가 계층과 검증 객체 고정 (MVP-7 보강)

- 상태: 로컬 적용. 실제 Cloudflare 배포 경로에서의 확인은 BLOCKED(D07/D08, 배포 없음).
- 근거 문서(2026-10-23 확인): Cloudflare R2 Workers API reference(get `onlyIf`/`range`, 조건 실패 시 body 없는 `R2Object`, 쓰기·삭제 strong consistency, `complete()` 가 `R2Object` 반환), R2 presigned URLs(bearer, 1초–7일, 서명 대상 = 리소스·메서드·만료, 사용자/세션 바인딩 없음).

## 1. 서명 URL: 누가, 어느 계층에서 막는가

이 구현의 업로드·다운로드 URL 은 **R2 presigned URL 이 아니라 Worker 경로**(`PUT /v1/chunks/<token>`, `GET /v1/blobs/<token>`)다. 브라우저는 R2 에 직접 접근하지 않는다.

| 계층 | 검사 | 다른 사용자가 URL 을 가진 경우 |
|---|---|---|
| L1 Worker 인증 | `Authorization: Bearer` 세션 필수 → ownerId | 세션 없음 → 401 |
| L2 토큰 서명 | HMAC(SIGNING_SECRET) 으로 owner·upload/part 또는 project·kind·hash·method·만료 고정 | 변조 → 403, 만료 → 403 `UPLOAD_EXPIRED` |
| L3 토큰 owner = 세션 owner | 토큰의 `o` 와 세션 ownerId 비교 | 다른 계정 세션 → 403 |
| L4 D1 owner 범위 조회 | R2 key 는 토큰이 아니라 D1 `objects/uploads`(owner 범위, state=ready)에서 얻는다 | 남의 객체 key 를 지정할 방법 없음 |
| L5 R2 private bucket | Worker 바인딩으로만 접근 | 배포 설정 요구사항(아래) |

즉 **URL 은 그 자체로 접근 권한이 아니다**. 다른 사용자의 차단은 L1+L3(Worker) 에서 일어나고, L2 는 위조·재사용 범위를, L4 는 key 지정을 막는다.

### 로컬 대체 서버와 실제 경로의 차이
- 로컬 서버(`apps/api/local/server.ts`)와 테스트는 **같은 `handle()` 코드**를 실행한다. 다른 것은 바인딩 구현(D1=node:sqlite, R2=메모리)과 런타임(Node vs workerd)뿐이다. 로컬 R2 는 네트워크에 노출되지 않으며(프로세스 내부), 실제 R2 private bucket 도 바인딩 외 접근이 없어야 한다 — 이 동등성은 **배포 설정이 맞을 때만** 성립한다.
- 따라서 C04 판정은 환경별로 분리한다: Node 대체 PASS / workerd NOT-RUN / Cloudflare 배포 BLOCKED. Node 결과로 배포 보안 요구사항을 통과 처리하지 않는다.

### R2 presigned URL 을 쓰게 될 경우(미채택)
- presigned URL 은 bearer 다: URL 을 가진 누구나 만료 전까지 해당 객체·메서드를 쓸 수 있고 세션에 묶을 수 없다. 이 경우 "URL 을 가진 다른 사용자 차단"은 **불가능**하며 C04 의 URL 항목은 요구사항 재정의(짧은 만료, 정확한 key/method, Content-Type 지정, CORS)가 필요하다. 또한 Worker 의 chunk hash 검증이 빠지므로 검증은 complete 의 서버 job 에만 의존한다. 채택 여부는 D07/D08(대역폭·비용) 선택 사항이며 채택 시 이 문서와 테스트를 다시 써야 한다.

### 배포 시 확인해야 할 설정(체크리스트, 미실행)
- R2 bucket: public access(r2.dev) 비활성, custom domain 연결 없음, 클라이언트용 S3 API token 발급 없음.
- `SIGNING_SECRET`·공급자 secret 은 `wrangler secret` 으로만, 저장소·로그에 없음. 토큰이 URL path 에 있으므로 요청 로그 보존 정책 확인(토큰만으로는 접근 불가하지만 노출 최소화).
- `ALLOWED_ORIGINS` = 실제 앱 origin 만. `AUTH_MODE` 는 실제 공급자 값, `ENVIRONMENT=production`.

## 2. 큰 파일 검증 도중 객체 변경 방지

이전 구현의 문제: 같은 hash 의 재업로드가 같은 R2 key 를 덮어쓸 수 있었고, 검증 job 의 range read·snapshot 파싱·다운로드가 "검증한 그 객체"인지 확인하지 않았다(검증 후 교체 시 다른 바이트가 나갈 수 있음).

변경:
1. **업로드별 고유 key**: `o/<owner>/<project>/<kind>/<hash>/<uploadId>`. 다른 업로드(동시 재업로드 포함)는 다른 key 에 쓰므로 검증 중·ready 객체를 덮어쓸 수 없다. R2 쓰기는 이 Worker 코드 경로뿐이다.
2. **검증 버전 고정**: multipart `complete()` 가 돌려준 `R2Object.etag` 를 D1 `uploads.verify_state` 에 저장하고, 모든 range read 는 `get(key, { range, onlyIf: { etagMatches } })` 로 한다. 조건 실패(R2 는 body 없는 R2Object 반환) 또는 `head().etag` 불일치 → 업로드 `rejected` + 422 `OBJECT_CHANGED`, 객체 삭제.
3. **ready = (r2_key, etag)**: `objects.etag` 컬럼(migration 0002). snapshot 파싱도 같은 etag 로 읽고 바이트 hash 를 다시 확인한다.
4. **다운로드도 같은 버전만**: `/v1/blobs` 는 `objects` 의 (r2_key, etag) 로 `onlyIf.etagMatches` 읽기. 바뀌었으면 바이트를 주지 않고 409 `OBJECT_CHANGED`. 클라이언트는 받은 바이트를 다시 hash 검증한 뒤 import 한다(`importAsset(bytes, expectedHash)`, snapshot hash 비교).
5. **commit 이 가리키는 객체 = 검증한 객체**: commit 은 `objects` 의 (owner, project, kind, hash, state=ready) 행만 참조하고, 그 행은 하나의 (r2_key, etag) 에 묶인다. 같은 hash 가 두 번 검증되면 먼저 ready 된 행을 유지하고 나중 사본은 삭제한다(`ON CONFLICT DO NOTHING` + 삭제).
6. GC: D1 에 없는 R2 key(complete 후 D1 갱신 전 crash 등)는 7일 후 sweep.

근거: R2 쓰기는 strongly consistent 이고 `complete()` 직후 전역에서 읽힌다 → complete 가 돌려준 etag 의 객체를 바로 범위 읽기할 수 있다. etag 형식에는 의존하지 않고 같음만 비교한다(`etagMatches`). 로컬 어댑터는 단일 put = MD5, multipart = `md5(part md5)-N` 으로 흉내 내지만 실제 R2 형식은 확인하지 않았다. 같은 바이트로 덮어쓴 경우 etag 가 같을 수 있으나 바이트가 같으므로 "검증한 바이트 = 내보내는 바이트" 불변조건은 유지된다(테스트는 다른 바이트로 덮어쓴다).

한계: 로컬 R2 어댑터의 `onlyIf`·etag 는 위 계약을 흉내 낸 것이다. 실제 R2 의미는 workerd/Miniflare 계약 테스트(`apps/api/test/workerd.test.ts`, CI 전용)와 실제 R2 staging 에서만 확인된다 — 현재 둘 다 결과 없음.
