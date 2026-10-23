# MVP-1 보고서 — 오프라인 프로젝트·저장·복구 기반

작성 2026-10-23 · 환경: Pi 4B(Node v24.21.0, Vitest 5.0.5 + fake-indexeddb 6.2.6), headless Chromium 154(Playwright 1.64.1)

## 1. 구현된 사용자 흐름과 변경 파일

흐름: 홈 → 새 프로젝트 → Bass/Guitar TAB·Keys·Drums 트랙 추가 → 이름(✎)/템포 변경 → Undo/Redo(↶↷, Ctrl+Z/Y) → 자동 저장(1초 debounce, 최대 5초) → 브라우저 재시작 → 목록에서 열기 → "백업"(.bassdaw) → 다른 프로필에서 "백업 가져오기" → 새 사본. 저장 상태 표시: 저장됨/미저장/저장 중/저장 문제/용량 실패/읽기 전용. 홈의 "버전"에서 revision 목록·손상 표시·"이 버전으로 복원".

| 패키지 | 내용 |
|---|---|
| `packages/schemas` | 02 타입 전부, 구조+의미 검증기(알 수 없는 필드 거절, 범위·참조·DAG·현 겹침·주법 링크·한도), canonical JSON(키 정렬, -0→0), SHA-256(증분), serialize/deserialize, FUTURE_VERSION read-only, n→n+1 migration 체인, 팩토리(F00) |
| `packages/project-core` | 명령 레지스트리(Create/DeleteTrack, Create/ReplaceSource, Place/Move/Trim/Split/Duplicate/DeleteClip, EditNotes, SetTempoMap, SetRouting, SetParameter, EditAutomation 외), 구조 공유 불변 갱신, Batch 원자성, copy-on-write(새 source·이벤트 ID, 링크 재매핑), editSequence/STALE_EDIT, Undo 100개/64MiB |
| `packages/storage` | IndexedDB stores(projects/revisions/snapshots/assets/journals/outbox/leases/blobs/meta), OPFS·IDB Blob·Memory ByteStore, commit 프로토콜 1–5(자산 staging→검증→promote(copy+재검증)→단일 IDB tx 의 head CAS), writer lease+epoch fencing(+Web Locks), degraded open, recover/restoreRevision, GC(최근 100 + 24h 시간별 + pin + journal/outbox reachability, 7일 유예), `.bassdaw` ZIP(직접 작성한 리더: central directory 선검사, path traversal/절대경로/symlink/암호화/중복/entry 수/압축비/헤더 위조 방어), AutosaveController(quota → 캐시 정리 → 1회 재시도 → 백업 안내) |
| `packages/music-core`(일부) | 클립 전개(S05) |
| `apps/web` | 홈·편집기 shell·트랙 목록·빈 타임라인·저장 상태·복구 UI, PWA(hash 버전 shell SW, 사용자 선택 업데이트), BroadcastChannel 알림 |
| `.github/workflows/ci.yml` | install/typecheck/test/build/e2e (작성만, GitHub 에서 미실행) |

## 2. 명령

| 명령 | 실행 |
|---|---|
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm test` (전체 105 tests) | ✅ |
| `pnpm test:e2e -- tests/e2e/m1-storage.spec.ts` | ✅ |
| GitHub Actions | ❌ NOT-RUN (push 요청 없음) |

## 3. 수용 테스트

| ID | 결과 | 근거(파일) · 수치 |
|---|---|---|
| S01 | PASS | F00/F03 canonical round trip, 바이트·ID·날짜 동일 (`packages/schemas/test/schema.test.ts`) |
| S02 | PASS | seed 20261022 로 10,000 무효 입력(70 종 변형 모두 등장) 전부 거절, 원본 hash 불변 |
| S03 | PASS | 동음이현·주법·CC·pitch bend·미설치 plugin state/parameter/automation 보존 |
| S04 | PASS | music/loop/audio split → Undo 원본 hash 동일, audio split 프레임 합 정확 (`project-core/test`) |
| S05 | PASS | trim/loop 반개구간, 경계 노트, occurrence, voiceKey 유일 (`music-core/test`) |
| S06 | PASS | 미래 schemaVersion: FUTURE_VERSION·입력 바이트 불변, 저장소 head·snapshot 바이트 불변; 실패 migration 시 입력 불변 |
| L01 | PASS | Node(fake-IDB) + **브라우저 persistent profile 재시작**: 트랙 4·이름·템포 복원, 자산 hash 동일 |
| L02 | PASS (Node fault injection) | commit 경계 1–5 에서 예외 주입 후 재오픈: old 또는 new 의 온전한 head 만. 실제 브라우저 프로세스 kill 주입은 NOT-RUN |
| L03 | PASS | quota(QUOTA), autosave quota→캐시 정리→재시도→quota-error+백업 안내, OPFS 불가(IDB Blob 어댑터), 자산 소실 → degraded open + 재커밋 가능, 손상 snapshot → SNAPSHOT_CORRUPT + 정상 revision 후보·복원(덮어쓰기 없음) |
| L04 | PASS | Node: WRITER_HELD → takeover → 이전 탭 WRITER_LOST, stale head LOCAL_HEAD_CHANGED, 만료 lease. 브라우저 2 탭: 두 번째 탭 읽기 전용 → 가져오기 → 첫 탭 다음 write 에서 읽기 전용 |
| L05 | PASS | archive round trip(새 ID, originProjectId, 자산 hash 동일), path traversal/절대/드라이브/백슬래시/symlink/zip bomb(비율)/헤더 위조/entry 수/hash 불일치 거절·head 불변, 브라우저 다른 프로필 복원 |
| B01 | PARTIAL PASS | headless: SW 제어 후 오프라인 reload → 앱 shell·프로젝트 열기 성공(첫 시도에서 Vite `Vary: Origin` 때문에 실패 → SW `ignoreVary` 수정). "업데이트 중 강제 reload 없음"은 코드상 사용자 버튼+재생/녹음 중 거부로 구현, 자동 테스트 NOT-RUN. 실기 BLOCKED |
| 성능: 소규모 명령 | 측정 | 16 트랙 10,000 노트에서 노트 1개 수정 p95 13.5ms / p50 9.7ms (Pi Node; 최초 36ms → 검증 캐시로 개선) — 목표 16ms 이내 |
| 성능: autosave 500ms | NOT-RUN(브라우저 실측) | fake-IDB 수치는 실측이 아니어서 기록하지 않음 |

## 4. 결정·포맷

- decisions 0001(파라미터 ID 대소문자 모순 → 정규식 완화), 0002(descriptor 위치), 0003(전역 ID·pad 예외).
- 영속: `Project` schemaVersion 1 (미배포). archive `manifest.json`(archiveVersion 1, snapshotHash, entries, plugins, requiredExternal, portable).

## 5. 미해결·확인 절차

- 실기: Chromebook 에서 프로젝트 생성 → 4트랙 → 저장 → Chrome 종료 → 재실행 → 확인; 설치형 PWA 오프라인 재시작(신뢰된 HTTPS 필요).
- GC 의 staging orphan 24시간 유예는 생성 시각을 OPFS 가 주지 않아 "현재 세션 외 파일" 기준으로 근사(녹음 journal 이 참조하는 segment 는 보존).

## 6. 판정

코드 완료 ✅, 자동 테스트 ✅(L02 브라우저 kill·B01 업데이트 경로 제외), 실기 BLOCKED. 사용자 지시에 따라 MVP-2 로 진행.
