# 로컬 .dawbae 프로젝트 파일 전환

2026-10-23. 사용자 요청으로 클라우드 동기화 대신 로컬 파일 저장으로 전환했다. 기존 베이스/드럼 악보·편집·재생·브라우저 복구 사본은 유지한다.

## 동작

- `.dawbae` 한 파일에 프로젝트 JSON·manifest·원본 음원/녹음을 묶는다. 기존 `archiveVersion:1` ZIP 구조와 프로젝트 스키마를 유지한다. `.bassdaw`도 읽을 수 있다.
- 현재 편집 snapshot에서 바로 생성하므로 브라우저 자동 commit을 기다리거나 그 성공을 파일 저장으로 간주하지 않는다. 개인 로컬 파일에는 재배포 제한 자산도 원래 라이선스 메타데이터와 함께 보존한다. 이는 공유 허가를 부여하지 않는다. 원본 bytes가 없으면 저장을 거절한다.
- 최초 저장/다른 이름 저장은 picker를 먼저 호출한다. 파일 저장/Ctrl+S는 성공적으로 연결한 파일을 갱신한다. Ctrl+Shift+S는 다른 이름 저장. 입력 필드 포커스 중 Ctrl+S도 현재 값을 반영한다.
- File System Access가 없으면 다운로드 fallback을 사용하고 **'파일 다운로드 요청됨'**으로 표시한다. OS 쓰기 완료까지 확인한 것처럼 표시하지 않는다. picker 취소는 다운로드로 우회하지 않는다.
- 파일 write/close/권한 실패 시 성공 sequence/기존 handle을 바꾸지 않고 abort를 시도한다. 저장 도중 새 편집은 미저장으로 남는다. 파일 저장 상태와 브라우저 복구본 상태는 별도다.
- 파일을 열면 같은 저장소의 기존 프로젝트를 덮어쓰지 않도록 독립 복구 사본으로 import한다. 원곡 데이터·오디오 hash·재생 이벤트를 보존하며 로컬 프로젝트 ID/updatedAt/originProjectId만 가져오기 관례대로 갱신한다. 이후 연결한 파일로 저장할 수 있다.
- 파일 핸들은 세션에만 보관한다. 재접속 시 파일을 다시 열어야 연결된다. 예전 `.bassdaw` 파일에는 덮어쓰지 않고 `.dawbae`로 새 이름 저장한다.

## 클라우드 경로

활성 앱의 로그인·클라우드 상태·동기화 탭·초기화/폴링을 제거했다. API 환경변수를 설정해도 현재 앱은 원격 동기화를 시작하지 않는다. 기존 API·동기화 도메인 코드/테스트는 과거 구현 보존용으로 남겼다. 오래된 UI 브라우저 시나리오 2개는 `tests/legacy/m7-sync.spec.ts`로 옮겨 현재 기능의 통과로 세지 않는다. 현재 Playwright 실행에는 로컬 API 서버도 필요 없다.

Workers 배포는 정적 웹 앱만 대상이며 D1·R2·실제 로그인 공급자가 필요 없다. 배포 구성은 루트 `wrangler.jsonc`; 과거 `apps/api/wrangler.toml`은 배포하지 않는다.

## 검증 근거와 한계

Node/Vitest와 Pi Chromium headless에서 검사한다. 파일 다운로드·새 프로필에서 열기는 실제 `.dawbae` ZIP bytes로 검증한다. 브라우저 네이티브 저장 대화상자·디스크 오류·덮어쓰기 완료는 자동 테스트에서 **주입한 file handle/stream 계약**으로 검증하며, 실제 OS 파일 선택기/Chromebook 저장 실사용 결과로 대체하지 않는다.

검사 내용:
- 현재 미commit snapshot 및 원본 자산의 무손실 archive round-trip, 원본 프로젝트 hash 불변.
- 누락 음원의 불완전 저장 거절.
- 한국어 파일명·확장자·다운로드 fallback, 파일 저장과 복구본 상태 분리.
- 취소·권한 거절·write/close 실패 시 이전 bytes 유지(주입한 계약).
- 저장 도중 추가 편집은 미저장 상태, 후속 저장 후 다시 열기.
- 실제 파일 다운로드 → 새 브라우저 프로필 가져오기 → tracks/sources/assets·오디오 SHA-256·재생 계획 hash 동일.
- 이전 `.bassdaw` 호환과 손상 `.dawbae` 거절, 기존 프로젝트 보존.
- 오프라인 파일 저장 및 클라우드 API 요청 0.
- 기존 복구·다중 탭 fencing·WAV/MIDI·기보·플러그인 회귀.

실제 Chromebook/Android/iOS의 picker·다운로드·대용량 파일 저장, 실제 디스크 full/권한 해제는 **NOT-RUN**. 자동 다운로드 완료 확인은 브라우저가 제공하는 범위를 넘겨 보장하지 않는다.

관련 결정: `docs/decisions/0014-local-project-files.md`. 테스트: `packages/storage/test/storage.test.ts`, `apps/web/test/project-file.test.ts`, `tests/e2e/local-project-file.spec.ts`. 다운로드 산출물: `tests/artifacts/local-files/song.dawbae`.
