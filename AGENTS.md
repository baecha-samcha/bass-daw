# AGENTS.md — 코딩 에이전트 안내

- 먼저 `docs/reports/` 최신 보고서와 `docs/decisions/` 를 읽는다. 명세는 `docs/specs/`(부록 포함)가 최신이다.
- pnpm 은 corepack shim(`~/.local/bin/pnpm` → `corepack pnpm@10.34.7`). 전역 설치·root 금지.
- 확인 순서: `pnpm typecheck && pnpm test && pnpm test:e2e`. e2e 는 `/usr/bin/chromium` 과 `vite preview :4173` 을 쓴다. Pi 메모리 때문에 worker 1.
- 도메인 패키지(`packages/*`)는 React/Zustand/네트워크를 import 하지 않는다. UI 는 `apps/web` 만.
- 영속 포맷(`packages/schemas/src/types.ts`) 변경은 decisions 기록 + 사용자 확인 후. 테스트 기대값은 구현을 복사하지 말고 독립 오라클(`tests/fixtures/oracle.ts`, `wavparse.ts`, `midiparse.ts`)을 쓴다.
- 실제 기기(Chromebook/모바일/loopback) 결과와 Pi/headless 결과를 구분해 보고한다. BLOCKED/NOT-RUN 을 PASS 로 쓰지 않는다.
- 셸에서 `pkill -f "<pattern>"` 은 자기 자신의 명령줄과 매칭되어 셸을 죽일 수 있다 — `fuser -k 4173/tcp` 를 쓴다.
