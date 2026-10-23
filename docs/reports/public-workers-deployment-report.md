# 공개 저장소와 Workers 배포

## 배포 완료 — 2026-10-23

- 서비스: **https://daw.baecha.xyz** (Workers Custom Domain).
- 보조 주소: https://bass-daw.niceliobae.workers.dev
- Worker: `bass-daw`, version `8d13b811-5624-4788-93ec-e4352c0fd266`.
- 코드: `4ade338`과 동일한 앱 코드. 최신 production 빌드 + 번들 검사 후 배포했다.
- 사용자 Wrangler Device OAuth 로그인 확인 후 사용자 지정 `daw.baecha.xyz`만 연결했다. 배포 전 대상은 DNS NXDOMAIN / Worker 커스텀 도메인 미등록 / `bass-daw` Worker 미존재였다. 일반 DNS API 조회는 OAuth 권한상 403이었으나 공개 DNS 및 Workers 도메인 API로 대상을 확인했고, Workers Custom Domain 등록으로 DNS/TLS를 자동 구성했다.
- 루트 `wrangler.jsonc`에 계정과 커스텀 도메인을 기록했다. D1/R2 바인딩 없음. 프로젝트는 브라우저/로컬 `.dawbae` 파일에만 저장한다.
- 명령은 **`pnpm run deploy`**다. `pnpm deploy`는 pnpm 자체 workspace 배포 명령이므로 이 앱 스크립트 실행에는 쓰지 않는다.

### 실제 공개 주소 검증 — PASS

`node scripts/verify-public.mjs https://daw.baecha.xyz` 실행:

| 확인 | 결과 |
|---|---|
| `/`, `/sw.js`, manifest, Bravura 폰트, alphaTab LICENSE, 플러그인 목록 | HTTP 200 |
| COOP/COEP/CORP | 각각 same-origin / require-corp / same-origin |
| 브라우저 보안 컨텍스트·crossOriginIsolated·SharedArrayBuffer | 모두 true |
| 오디오 엔진 초기화·재생·정지 | PASS(headless, 실제 청취 아님) |
| 실제 `.dawbae` 다운로드 → 새 브라우저 컨텍스트에서 파일 열기 | PASS, 재생 계획 hash 동일 |
| 베이스·드럼 악보 SVG, 범례, 드럼 A4 PDF | PASS |
| 악보 출력 전후 프로젝트 hash/edit sequence | 동일 |
| 콘솔 pageerror / 클라우드 API 요청 | 0 / 0 |

근거: `tests/artifacts/deployment/public-smoke.json`, `public-smoke.dawbae`, `public-drum-score.png`, `public-drum-score.pdf`.
이 결과는 Pi Chromium headless의 실제 공개 HTTPS 서비스 검증이다. **실제 Chromebook·OS 파일 대화상자·청취·프린터는 미검증**이며, 파일 검사는 다운로드 fallback을 사용했다.

## 배포 전 준비 기록(과거 상태)

2026-10-23. 사용자 요청으로 공개 GitHub 저장소를 생성하고, 로컬 `.dawbae` 파일 저장 버전의 Workers Static Assets 배포를 준비했다.

- 저장소: https://github.com/baecha-samcha/bass-daw (public).
- 루트 `wrangler.jsonc`: Worker 이름 `bass-daw`, 업로드 디렉터리 `apps/web/dist`, SPA fallback, workers.dev.
- `pnpm run deploy`: production 빌드 → production bundle 검사 → 루트 Worker 배포. 과거 동기화 API의 D1/R2 바인딩 설정은 사용하지 않는다.
- `_headers`: COOP same-origin, COEP require-corp, CORP same-origin, nosniff, referrer policy. 앱 shell/SW는 no-cache로 갱신 확인.
- `.wrangler`, 환경 secret, 인증서, 테스트 산출물은 gitignore. 공개 대상 파일에서 private key/GitHub/Cloudflare/AWS 토큰의 높은 신뢰도 패턴을 검사했고 발견되지 않았다(완전한 비밀 탐지 보증을 의미하지 않음).
- alphaTab/Bravura 라이선스와 notice를 공개 소스 및 정적 자산에 포함했다.

**배포 전 상태(해소됨):** `pnpm exec wrangler whoami`는 미인증을 반환한다. 계정 OAuth 로그인 또는 배포용 API token이 필요하다. 자격 증명 없이 배포 성공/주소를 보고하지 않는다. D1/R2 생성은 이 로컬 파일 저장 방식에서 필요 없다.

Workers에 실제 배포한 뒤에는 HTTPS·COOP/COEP/CORP·crossOriginIsolated/SharedArrayBuffer·오디오 시작·프로젝트 파일 저장/열기·기보 렌더를 공개 주소에서 다시 검증해야 한다. 현재 자동 로컬 브라우저 결과를 공개 서비스 결과로 대신하지 않는다.

초기 GitHub CI에서는 보존된 옛 클라우드 API의 실제 workerd 계약 4개가 500 응답으로 실패했다. 현재 배포되는 로컬 파일 앱과 별개이며 PASS로 바꾸지 않는다. 이후 기본 CI는 현재 앱과 Node 회귀를 실행하고, 은퇴한 workerd 계약은 `REQUIRE_WORKERD=1` 및 workflow_dispatch의 `legacy_cloud_contract`로 명시적으로 선택하도록 구분했다.

최종 코드 `4ade338`은 공개 저장소 `main`으로 push했다. [GitHub CI](https://github.com/baecha-samcha/bass-daw/actions/runs/39895886787)는 성공했으며 단위207/브라우저35 통과, production 번들 검사 및 별도 Pi Wrangler dry-run도 통과했다. 당시 Worker용 Cloudflare 인증 미설정으로 실제 배포/공개 검증은 미완료였으며, 아래 배포 기록은 그 뒤 사용자 OAuth 로그인으로 해소한 결과다. 마지막 보고서 변경은 코드 변경 없이 별도 commit으로 반영한다.
