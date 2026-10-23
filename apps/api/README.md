# apps/api — 동기화 Worker (MVP-7)

Workers 는 인증·인가·업로드 허가·검증·commit 만 담당한다(오디오 렌더 없음). 설계: `docs/decisions/0010-cloud-sync.md`.

- `src/` Worker 코드(Cloudflare 런타임/로컬 공통), `migrations/` D1 스키마
- `local/` 이 Pi 용 로컬 대체: node:sqlite D1, 메모리/디렉터리 R2, HTTP 서버 (workerd 는 커널 39-bit VA 로 실행 불가)
- `pnpm --filter @bass-daw/api dev` → http://localhost:8787 (fake auth, 실행마다 무작위 secret)
- `wrangler.toml` 은 placeholder 초안이다. 실제 계정·D1·R2·도메인·secret 은 만들지 않았다(D07/D08 선택 후 사용자 진행). fake 값은 `.dev.vars`(gitignore)에만.
