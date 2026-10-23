# 공개 저장소와 Workers 배포 준비

2026-10-23. 사용자 요청으로 공개 GitHub 저장소를 생성하고, 로컬 `.dawbae` 파일 저장 버전의 Workers Static Assets 배포를 준비했다.

- 저장소: https://github.com/baecha-samcha/bass-daw (public).
- 루트 `wrangler.jsonc`: Worker 이름 `bass-daw`, 업로드 디렉터리 `apps/web/dist`, SPA fallback, workers.dev.
- `pnpm deploy`: production 빌드 → production bundle 검사 → 루트 Worker 배포. 과거 동기화 API의 D1/R2 바인딩 설정은 사용하지 않는다.
- `_headers`: COOP same-origin, COEP require-corp, CORP same-origin, nosniff, referrer policy. 앱 shell/SW는 no-cache로 갱신 확인.
- `.wrangler`, 환경 secret, 인증서, 테스트 산출물은 gitignore. 공개 대상 파일에서 private key/GitHub/Cloudflare/AWS 토큰의 높은 신뢰도 패턴을 검사했고 발견되지 않았다(완전한 비밀 탐지 보증을 의미하지 않음).
- alphaTab/Bravura 라이선스와 notice를 공개 소스 및 정적 자산에 포함했다.

**배포 인증 미완료:** `pnpm exec wrangler whoami`는 미인증을 반환한다. 계정 OAuth 로그인 또는 배포용 API token이 필요하다. 자격 증명 없이 배포 성공/주소를 보고하지 않는다. D1/R2 생성은 이 로컬 파일 저장 방식에서 필요 없다.

Workers에 실제 배포한 뒤에는 HTTPS·COOP/COEP/CORP·crossOriginIsolated/SharedArrayBuffer·오디오 시작·프로젝트 파일 저장/열기·기보 렌더를 공개 주소에서 다시 검증해야 한다. 현재 자동 로컬 브라우저 결과를 공개 서비스 결과로 대신하지 않는다.

초기 GitHub CI에서는 보존된 옛 클라우드 API의 실제 workerd 계약 4개가 500 응답으로 실패했다. 현재 배포되는 로컬 파일 앱과 별개이며 PASS로 바꾸지 않는다. 이후 기본 CI는 현재 앱과 Node 회귀를 실행하고, 은퇴한 workerd 계약은 `REQUIRE_WORKERD=1` 및 workflow_dispatch의 `legacy_cloud_contract`로 명시적으로 선택하도록 구분했다.

최종 코드 `4ade338`은 공개 저장소 `main`으로 push했다. [GitHub CI](https://github.com/baecha-samcha/bass-daw/actions/runs/39895886787)는 성공했으며 단위207/브라우저35 통과, production 번들 검사 및 별도 Pi Wrangler dry-run도 통과했다. 현재 Worker용 Cloudflare 인증과 제안한 로컬 API token 파일은 미설정이므로 **실제 Workers 배포와 공개 사이트 검증은 미완료**다. 마지막 보고서 변경은 코드 변경 없이 별도 commit으로 반영한다.
