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
