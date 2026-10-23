# 현재 운영: 로컬 .dawbae 파일

2026-10-23 방향 전환: 프로젝트 저장/기기간 이동은 `.dawbae` 파일로 한다. 브라우저 IDB/OPFS는 복구용 사본이다. 활성 앱은 클라우드 API·로그인·D1·R2를 사용하지 않는다.

- 파일 열기: 홈의 `파일 열기 (.dawbae)`. 이전 `.bassdaw` 호환.
- 파일 저장: `파일 저장 (.dawbae)` / Ctrl+S. 다른 이름 저장: Ctrl+Shift+S.
- 직접 파일 저장 미지원 시 다운로드를 사용하며 완료는 브라우저에서 확인한다. 원본 bytes 누락/디스크 실패 시 파일 저장 실패로 표시한다.
- Workers 배포: `pnpm deploy`(루트 `wrangler.jsonc`), Cloudflare 계정 인증 필요. `.dawbae` 파일은 서버로 업로드하지 않는다.
- 자세한 상태: `docs/reports/local-project-file-report.md`, `docs/reports/public-workers-deployment-report.md`.

아래 내용은 **이전 클라우드 동기화 구현의 역사적 runbook**으로 보존하며 현재 앱 배포 절차가 아니다.

---

# 운영 runbook (초안)

상태: **로컬 절차만 Pi 에서 확인**. staging/production 절차는 D07/D08 선택과 실제 Cloudflare 리소스 생성 후 staging·복제 데이터로 검증해야 한다(미검증 — 아래 "미검증" 표시).

## 1. 개발 환경 설치
```bash
corepack pnpm@10.34.7 install            # ~/.local/bin/pnpm shim 사용 가능
pnpm typecheck && pnpm test && pnpm test:e2e
pnpm dev:api                              # 로컬 API :8787 (fake auth, state=tests/artifacts/api-state)
pnpm dev                                  # 웹 :5173 (apps/web/.env.development → VITE_API_BASE)
```

## 2. 환경변수
| 위치 | 변수 | 값 | 비고 |
|---|---|---|---|
| web 빌드 | `VITE_API_BASE` | 개발 `http://localhost:8787` / production 미설정(동기화 비활성) | 실제 도메인은 D07 |
| web e2e 빌드 | `VITE_E2E_REVIEWED` | `scripts/build-e2e.mjs` 가 설정 | `--mode e2e` 에서만 읽음, 배포 금지 |
| Worker vars | `AUTH_MODE` | `none`(기본) / `fake`(로컬 전용) | 실제 공급자 값은 D07 후 |
| Worker vars | `ENVIRONMENT` | `production`(기본) / `development` | fake 는 development+localhost 에서만 |
| Worker secret | `SIGNING_SECRET`, `FAKE_AUTH_SECRET`(로컬) | 16자 이상 무작위 | placeholder 는 거절됨. 저장소·로그에 두지 않음 |
| Worker vars | `ALLOWED_ORIGINS`, `CHUNK_BYTES`, `MAX_ASSET_BYTES`, `QUOTA_BYTES`, `URL_TTL_SEC`, `UPLOAD_TTL_SEC`, `VERIFY_BUDGET_BYTES`, `RATE_LIMIT_PER_MIN`, `TOMBSTONE_RETENTION_DAYS` | 제안값(`wrangler.toml`) | D08 승인 전 확정 아님 |

## 3. 빌드·배포 전 필수 검사
```bash
pnpm build && node scripts/check-prod-bundle.mjs    # fake auth/e2e hash/로컬 API 주소 없음
node apps/api/scripts/build.mjs                      # dist/worker.js
```
- 배포 산출물은 항상 `pnpm build`(production)로 다시 만든다. `scripts/build-e2e.mjs` 산출물은 배포하지 않는다.
- 배포 설정 체크리스트: `docs/decisions/0011` §1(R2 public access 없음, custom domain 없음, 클라이언트용 S3 token 없음, secret 등록). **미검증**.

## 4. D1 migration
- 파일: `apps/api/migrations/NNNN_*.sql`(순서대로, 이미 적용된 파일은 수정하지 않고 새 파일 추가).
- 로컬: 서버 시작 시 `d1_migrations` 표로 새 파일만 1회 적용(파일 단위 transaction, 실패 시 rollback 후 시작 중단). 확인: `apps/api/test/api.test.ts` "local D1 migrations", 같은 state 디렉터리로 2회 재시작.
- 실제 D1: `wrangler d1 migrations apply <db> --remote` 예정(wrangler 미설치). 배포 전 D1 export 로 백업. **미검증**.
- 하위 호환: migration 은 컬럼·표 추가만 사용한다(0002 = `objects.etag` 추가). 이전 Worker 빌드는 `etag` 가 NULL 인 행을 다루지 못하므로(현재 코드는 etag 없는 ready 객체 다운로드를 404 처리) 롤백 시 0002 이후 업로드는 이전 빌드에서 쓰지 않는다.

## 5. 백업·복원(사용자 데이터)
- 로컬 프로젝트: 앱의 "백업"(.bassdaw) → 다른 프로필/기기에서 "백업 가져오기"(새 사본으로 복원, 원본 hash 동일). 검증: e2e L05, MVP-5 demo.
- 로컬 API state(개발): `tests/artifacts/api-state/`(d1.sqlite + r2/objects) 디렉터리 복사. 서버 정지 후 복사할 것.
- 클라우드: 삭제는 tombstone(30일 제안) → `POST /v1/projects/:id/restore`. 물리 삭제(purge)는 구현하지 않음. 실제 R2/D1 백업 주기·보존은 D08. **미검증**.

## 6. 롤백
- 웹: 서비스워커는 hash 버전 shell 을 캐시하고 사용자가 "업데이트 적용"을 눌러야 전환한다. 이전 빌드로 되돌리면 새 SW 가 다시 배포되어 같은 절차로 전환된다. IndexedDB 버전은 1 그대로(MVP-7 은 선택 필드만 추가) → 이전 앱 빌드도 프로젝트를 연다(동기화 필드는 무시). 미래 schema 버전 프로젝트는 read-only 로 보존.
- Worker: 이전 `dist/worker.js` 재배포. 단 §4 의 migration 하위 호환 제한. **미검증**.

## 7. 장애 대응 요약
| 증상 | 확인 | 조치 |
|---|---|---|
| 모든 API 500 `CONFIG_REFUSED` | Worker vars/secret | fake auth 가 비개발 환경에 설정됐거나 secret 누락 — 의도된 거절 |
| 업로드 422 `OBJECT_CHANGED`/`HASH_MISMATCH` | 클라이언트 로컬 원본 hash | 원본은 삭제하지 않음. "지금 동기화"로 새 업로드 |
| 다운로드 409 `OBJECT_CHANGED` | R2 객체가 검증 후 바뀜 | 해당 객체를 가진 기기에서 재업로드 필요, 원인 조사 |
| 동기화 "로그인 필요" | 세션 만료/계정 불일치 | 같은 계정 재로그인. 다른 계정으로는 전송되지 않음 |
| 탭 "읽기 전용" | 다른 탭이 편집 중이거나 응답 없음 | 그 탭에서 저장 후 닫거나 "가져오기" |
