# Bass TAB DAW — 개발 계획 및 설계 검토

문서 버전: 2.0-review · 작성일: 2026-10-22 · 상태: 구현 전 검토안

이 묶음은 개발을 승인하지 않는다. 실행 코드 없이 계약 형태의 TypeScript만 정의한다. 사용자가 명시적으로 구현을 승인한 마일스톤만 착수한다. MUST는 필수, SHOULD는 사유를 기록한 예외 허용, MAY는 선택 사항이다. 모든 수치는 검증 전 설계 목표이며 측정 결과가 아니다.

## 1. 제품 범위와 확정 사항

장기 비전은 종합 웹 DAW이다. 첫 제품 검증 목표는 베이스·기타·키보드·드럼으로 16트랙 곡을 만들고, 재시작 후 복구하며, WAV·MIDI·프로젝트 백업을 내보내는 개인 작업 흐름이다. 보컬은 오디오 트랙과 녹음 기능으로 지원한다. TAB을 악보 이미지가 아닌 현·프렛·주법을 보존하는 음악 데이터로 다룬다.

사용자 확정 사항: React/TypeScript/Vite, Zustand, Web Audio/AudioWorklet, 선택적 Rust/WASM, 960 PPQ 정수 Tick, TAB/MIDI 독립 모델 및 공통 Performance Event, 동등한 네 악기 지원, IndexedDB/OPFS, Workers/D1/R2, 비로그인 로컬 사용, 후속 동기화·협업, 모바일과 데스크톱 동일 포맷, Vitest/Playwright/오디오 테스트, pnpm Workspaces/GitHub Actions. 이를 변경하지 않는다. Pi는 개발 환경일 뿐 운영 의존성이 없다.

## 2. 기존 파일 확인 및 결함

기존 `02-project-schema.md`와 `02-project-schema(1).md`는 15,313바이트의 같은 v1.1-draft 내용으로 확인했다. 본 묶음의 02 문서는 이 초안을 바탕으로 만든 후속 검토안이다. 기본 파일의 새 버전으로 저장하고 기존 원본은 버전 이력 및 중복 파일에 보존한다. 아직 배포된 프로젝트 포맷이 없으므로 문서 버전 2.0과 직렬화 schemaVersion 1은 별개이다.

| 문제 | 구현에 미치는 영향 | 이번 설계안 |
|---|---|---|
| 악기와 음원 인스턴스 연결 없음 | 노트가 있어도 무엇으로 소리 낼지 불명확 | instrumentSlot 및 샘플 매핑 명시 |
| 클립 길이와 오디오 프레임 관계 미정 | 템포 변경 시 녹음이 임의로 늘어남 | 음악 클립 Tick, 오디오 절대 시간 앵커 |
| 클립 내부 노트 직접 저장 | 자르기·루프·복제의 의미 불명확 | 독립 Source와 Clip 인스턴스, copy-on-write |
| Undo/Redo가 P3에만 등장 | 앞선 에디터 재작성 위험 | P0부터 명령·원자적 편집 계약 |
| 모바일 검증이 마지막 | 녹음·메모리·터치 결함 늦게 발견 | M0부터 실제 모바일 검증 |
| 플러그인 오류 격리를 포괄적으로 표현 | 한 Worklet 오류가 음성을 중단할 수 있음 | 신뢰 등급과 격리 한계 명시 |
| IndexedDB+OPFS를 하나의 원자적 저장으로 오해 가능 | 중간 장애에서 데이터 손실 | 자산 선확정 후 메타데이터 커밋 |
| 16트랙만으로 부하 정의 | 폴리포니·음원 크기·이펙트에 따라 결과 무의미 | 고정 fixture 및 장치별 보고 |
| 48kHz 고정으로 해석 가능 | 실제 장치 컨텍스트와 불일치 | 파일·테스트 기준 48kHz, 실시간 실제 rate 사용 |

## 3. 제안 결정과 승인 지점

아래는 스택 변경이 아닌 상세 설계 제안이며 승인 전 확정으로 취급하지 않는다.

| ID | 제안 기본값 | 승인/해결 시점 |
|---|---|---|
| D01 | Source/Clip 분리, 음악 Tick 앵커와 오디오 초 앵커 | M1 전 |
| D02 | v1은 step tempo, 오디오 time-stretch 제외 | M1 전 |
| D03 | P0부터 Command/Undo와 저장 revision 계약 | M1 전 |
| D04 | M2 내장 샘플러, 베이스/기타 표현 주법별 fallback 명시 | M2 전 |
| D05 | M6 외부 DSP는 검토·고정 해시 WASM만, 임의 JS DSP 미지원 | M6 전 |
| D06 | P7 전체 snapshot CAS + 충돌 분기, 자동 3-way merge 제외 | M7 전 |
| D07 | 로그인 공급자/도메인/실제 모바일 기기/음원 라이선스 선택 | 각각 M7/M0/M2 전 |
| D08 | 예산·클라우드 보존 기간·사용자별 업로드 한도 | M7 공개 배포 전 |

960 PPQ에서는 극단적으로 짧은 리듬·일부 튜플릿을 정확히 표현할 수 없다. v1은 가장 가까운 Tick으로 양자화하고 가져오기 손실을 보고한다. 샘플 정확 재생 목표는 이미 정해진 Tick을 오디오 프레임으로 변환하는 정확도이며 편집 해상도를 증가시키지 않는다.

## 4. 문서 의존성과 소유권

작성·검토 순서: 02 프로젝트 모델 → 01 엔진 → 03 플러그인 → 04 저장·동기화 → 05 테스트. 테스트 ID와 위험 검증은 처음부터 병행 정의한다. 03 파라미터 계약을 확정한 후 02 자동화 참조를 다시 검증하고, 04 커밋 프로토콜을 확정한 후 02 직렬화를 교차 검토한다.

02는 영속 데이터, 01은 파생 재생 데이터와 실시간 상태, 03은 DSP/파라미터 계약, 04는 revision과 바이트 영속화, 05는 검증 오라클을 소유한다. 다른 문서는 소유 문서 타입을 참조하며 복제 정의하지 않는다. apps/web만 Zustand와 React를 의존한다. 도메인 패키지는 UI·네트워크를 import하지 않는다.

제안 구조는 그대로 유지한다. music-core=시간/Performance Event, tab-engine·midi-engine=독립 소스의 어댑터, project-core=검증/명령/Undo, schemas=직렬화 계약, storage=로컬/동기화 어댑터, audio-engine=재생/DSP 호스트, ui=표현, apps/api=Workers. 플러그인 계약은 초기 audio-engine/contracts에 두고 M6에서 실제 소비 관계를 보고 packages/plugin-api 분리를 검토한다.

## 5. 마일스톤과 완료 기준

아래 공수는 숙련 개발자 기준 집중 작업일의 거친 계획 범위이며 AI 생성 시간이나 달력 일정이 아니다. 실제 일정은 M0 결과 후 다시 산정한다.

| 단계 | 산출 범위 | 의존성 / 예상 공수 | 완료 게이트 |
|---|---|---|---|
| M0 실행 가능성 검증 | HTTPS 원격 개발, 브라우저 기능 탐지, 오디오·저장·모바일 실험 계획 실행 | 승인 후 / 3–5일 | 실제 Chromebook+모바일의 AudioWorklet/OPFS/녹음/메모리 결과, 불가능 항목과 대안 기록 |
| M1=P0 기반 | 워크스페이스, 검증기, Command/Undo, 빈 타임라인, 로컬 저장, PWA, 프로젝트 백업 | M0,D01–03 / 8–15일 | S01–S06,L01–L05,B01 통과; 오프라인 재시작·자산 백업 복원 |
| M2=P1 재생 | Transport, 이벤트 컴파일, Worklet 샘플러, 기본 믹서, fixture 재생 | M1,D04 / 12–20일 | A01–A06, 기준 Chromebook 30분 16트랙 시험 통과 |
| M3=P2+P3 편집 | 네 악기 에디터, 다중 트랙, 복제/분할/트림/루프, Undo | M2 / 15–25일 | E01–E05; 각 악기 8마디 편집→저장→동일 재생 |
| M4=P4 오디오 | import, 비파괴 오디오 클립, 파형, 마이크, 지연 보정 | M3 / 12–20일 | R01–R05; 권한 거부·장치 분리·중단 복구 포함 |
| M5=P5 완성 흐름 | EQ/컴프/리버브, 버스/send, 자동화, PDC, WAV/MIDI | M4 / 15–25일 | A07–A10,X01–X04; 곡 작성→백업→다른 기기 복원→WAV |
| M6=P6 확장 | 버전 고정 플러그인, sandbox UI, WASM ABI, 예제 규격 적합성 | M5,D05 / 15–25일 | P01–P06, 무한 루프 검증은 별도 프로세스 watchdog |
| M7=P7 동기화 | 로그인, 사설 R2, D1 head CAS, outbox, 충돌 UI | M5,D06–08 / 12–20일 | C01–C07; 두 기기 충돌·재시도·삭제 복구 |
| M8=P8 제품 검증 | 전체 플랫폼·접근성·성능·장애 시나리오 | M6,M7 / 10–20일 | 고정 지원 매트릭스 전체 통과, 미해결 P0/P1 결함 0 |

전체 계획은 대략 112–195 집중 작업일 수준이며, 음원 제작·외부 심사·운영·실시간 협업은 별도이다. M5가 첫 개인용 베타 경계이며 M6/M7은 M5 이후 독립적으로 진행할 수 있다. 모바일 핵심 기능을 제외한 데스크톱 전용 출시로 게이트를 우회하지 않는다. 기기별 허용 트랙/폴리포니 차이는 표시한다.

## 6. 위임 규칙

각 구현 작업은 범위, 읽을 계약, 변경 가능한 패키지, 입력 fixture, 통과할 테스트 ID, 제외 범위를 포함해야 한다. 구현자는 미정 사항을 임의로 확정하지 않고 해당 D 항목을 반환한다. 한 작업은 가능하면 한 공개 계약과 한 사용자 흐름으로 제한한다. 계약 변경은 소비 패키지와 회귀 fixture를 함께 검토한다.

실행 승인 후 첫 위임 범위는 M0이다. 문서 작성 승인은 M0 실행이나 앱 구현 승인으로 해석하지 않는다. CI용 모의 오디오 통과를 실제 장치 오디오 검증으로 대체하지 않는다.

M0 위임 시 수행할 실험은 다음과 같다. (1) Pi 개발 서버를 Chromebook에서 HTTPS로 열고 AudioWorklet·SAB·OPFS·서비스워커 기능 탐지 결과 기록. (2) 48kHz 요청/실제 rate 및 사용자 gesture·suspend/resume 결과 기록. (3) 128MiB 자산 저장→브라우저 종료→복원·OPFS 미지원 fallback 확인. (4) 실제 Android/iOS에서 같은 저장·짧은 dry capture·다운로드 실험. (5) 진단용 impulse/sampler로 큐 공급 중 UI 100/500ms 정지를 각각 주입하여 끊김 경계 확인. (6) 결과를 근거로 profile·lookahead·지원 장치·음원 라이선스 선택안을 제출. 이 실험용 코드 작성도 별도 구현 승인 이후에만 허용한다. 실패 시 스택을 임의 교체하지 않고 제약·재현법·대안을 보고한다.

## 7. 근거와 설계 한계

공식 문서를 2026-10-22 확인했다. 아래는 API 동작 근거이며, 이 제품의 성능 보증이 아니다.

- [W3C Web Audio 1.0](https://www.w3.org/TR/webaudio-1.0/): 제어/렌더 스레드, AudioContext 및 오프라인 렌더링.
- [W3C Web Audio 1.1 draft](https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/): 진화 중인 render quantum; 구현은 버퍼 길이를 읽고 128을 하드코딩하지 않는다.
- [MDN process](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process): 처리 예외 후 node는 지속적으로 무음 출력.
- [MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated): SharedArrayBuffer 사용 조건.
- [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), [persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist): 로컬 저장·지속성 요청. 브라우저 삭제와 사용자 삭제까지 막는 백업이 아니다.
- [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/): batch 트랜잭션; R2까지 포함하는 분산 트랜잭션은 아니다.
- [Cloudflare R2 presigned URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): 제한된 객체 접근. 키를 클라이언트에 노출하지 않는다.

관련 세부 계약은 01–05에 정의한다. 미측정 성능 수치, 라이선스가 정해지지 않은 샘플, 미검증 브라우저를 완료로 표시하지 않는다.
