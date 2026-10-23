# Bass TAB DAW (bass-daw)

웹 DAW — 베이스·기타 TAB, 키보드, 드럼, 오디오/녹음 트랙을 편집하고 믹싱·자동화·WAV/MIDI·악보 출력을 지원한다.

**프로젝트는 `.dawbae` 로컬 파일로 저장한다.** 프로젝트·원본 음원·녹음을 하나의 ZIP 기반 파일에 묶으며 다른 기기에서 다시 열 수 있다. 로그인·클라우드 동기화·D1·R2는 사용하지 않는다. 브라우저 자동 저장(IDB/OPFS)은 장애 복구용 사본이며 컴퓨터의 파일 저장과 구분한다. 이전 `.bassdaw` 파일도 열 수 있다.

- `파일 저장 (.dawbae)` / Ctrl+S: 최초 파일 선택 후 동일 파일 저장(File System Access 지원 시).
- `다른 이름으로 저장` / Ctrl+Shift+S: 새 파일 선택.
- 미지원 브라우저에서는 다운로드로 저장하며 상태는 '다운로드 요청됨'이다. 완료는 브라우저에서 확인한다.
- 파일 핸들은 세션 내에서만 유지한다. 앱을 다시 열면 `.dawbae`를 다시 열어 연결한다.
- 원본 bytes가 누락되면 불완전한 파일을 정상 저장하지 않고 실패를 표시한다.
- 프로젝트 파일은 개인 저장용이다. 포함 음원·플러그인 공유는 각각의 라이선스를 따른다.

구현/검증: [로컬 파일 저장 보고서](docs/reports/local-project-file-report.md), [드럼 악보 보고서](docs/reports/drum-score-export-report.md). 실제 Chromebook·프린터 검증은 별도다.

## 빠른 시작 (Raspberry Pi 개발 서버)

```bash
# pnpm 은 corepack 으로(전역 설치 없이): ~/.local/bin/pnpm shim 또는 `corepack pnpm@10.34.7`
pnpm install
pnpm dev            # http://<pi>:5173  (localhost 는 secure context)
pnpm dev:https      # https://<pi>:5173 자체 서명 인증서(Chromebook 원격 접속용, 경고 수락 필요)
pnpm build && pnpm preview   # 프로덕션 빌드 + PWA 서비스워커, http://<pi>:4173
```

- 진단 페이지(MVP-0): `#/diagnostics`
- Chromebook 에서 Pi 로 접속할 때 AudioWorklet·마이크·서비스워커는 **secure context** 가 필요하다. `pnpm dev:https`(자체 서명) 또는 사용자가 선택한 HTTPS 터널을 쓴다. 포트 공개·터널 계정은 만들지 않았다(docs/reports/MVP-0-report.md).

## 검증 명령

```bash
pnpm typecheck                # TypeScript 7 (tsc)
pnpm test                     # Vitest: 도메인·DSP·저장·엔진 (Node, fake-indexeddb)
pnpm test:e2e                 # Playwright + 시스템 Chromium(/usr/bin/chromium), worker 1 (e2e 전용 빌드 + 로컬 API 자동 기동)
node scripts/check-prod-bundle.mjs  # pnpm build 후: production 번들에 fake auth·e2e hash 없음 확인
REQUIRE_WORKERD=1 pnpm vitest run apps/api/test/workerd.test.ts   # 과거 클라우드 API 수동 검증(x86_64), 현재 웹 앱 CI 범위 밖
PERF=1 F02_MINUTES=30 pnpm vitest run tests/perf   # F02 부하 오프라인 측정(참고치)
node scripts/probe-env.mjs    # 개발 환경 조사
```

## 구조

| 경로 | 역할 |
|---|---|
| `packages/schemas` | 02 영속 계약: 타입, 검증기, canonical JSON, SHA-256, 플러그인 descriptor |
| `packages/project-core` | 명령 레지스트리, 원자적 편집, copy-on-write, Undo/Redo |
| `packages/music-core` | tempo/meter 변환, Performance Event, 클립 전개 |
| `packages/tab-engine` · `midi-engine` | TAB(주법·스트로크)/MIDI/드럼 어댑터, SMF import/export |
| `packages/storage` | LocalStore(IDB+OPFS/IDB Blob), commit 프로토콜, lease, GC, `.bassdaw` archive, autosave, 이전 SyncEngine(현재 앱에서 비활성) |
| `packages/plugin-api` | 외부 플러그인: manifest·번들·WASM 검사, ABI1 런타임, 호스트 수명주기, 적합성 |
| `packages/notation` | 베이스 TAB·드럼 → 별도 기보 모델(범위·두 성부·범례·미지원 진단) |
| `plugins/` | 샘플 플러그인(WAT) → `node scripts/build-plugins.mjs` → `apps/web/public/plugins/*.bdplugin` |
| `packages/audio-engine` | RenderCore(샘플러·믹서·EQ/컴프/리버브·PDC·자동화), Scheduler/WorkletRuntime, offline WAV, 합성 키트 |
| `apps/web` | React + Zustand UI, AudioWorklet/worker glue, PWA |
| `apps/api` | 이전 구현 보존용 동기화 Worker(현재 앱 배포에 사용하지 않음)(인증 경계·업로드 검증·head CAS·tombstone), D1 migration, 로컬 D1/R2 어댑터·개발 서버 |
| `docs/specs` · `docs/prompts` | 명세·지시서 사본(부록으로 보완) |
| `docs/decisions` · `docs/reports` | 결정 기록, MVP 보고서 (MVP-8 은 부분 보고서) |
| `docs/runbook.md` | 설치·환경변수·migration·백업/롤백 초안(로컬 절차만 확인) |

## Cloudflare Workers 배포

웹 앱을 Workers Static Assets로 배포한다. 루트 `wrangler.jsonc`는 `apps/web/dist`만 업로드하며,
`apps/api/wrangler.toml`의 동기화 API 초안과 별개다. 현재 공개 앱은 로그인 없이 기기 내 저장을 사용한다.
클라우드 동기화 경로는 현재 앱에서 제거했으며 D1·R2·인증 공급자가 필요 없다.

```bash
pnpm exec wrangler login
pnpm deploy
```

`pnpm deploy`는 production 빌드와 번들 검사를 먼저 실행한다. 배포 계정에 `bass-daw` Worker가 생성되며
`workers.dev` 주소로 제공된다. `_headers`에 COOP/COEP/CORP를 설정해 SharedArrayBuffer와 AudioWorklet 조건을 유지한다.
API token이나 OAuth 자격 증명은 저장소에 넣지 않는다. CI 검증은 기존 workflow로 실행하며 자동 배포는 별도로 설정해야 한다.

악보 출력: 기존 악보 탭에서 베이스 또는 드럼 트랙을 선택한다. 드럼 패드 매핑·두 성부·인쇄 진단과
성능/실기 검증 범위는 `docs/reports/drum-score-export-report.md`를 참고한다.
타사 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리했다.
