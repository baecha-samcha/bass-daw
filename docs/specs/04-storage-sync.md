# 04 — 로컬 저장·백업·클라우드 동기화 명세

버전 2.0-review · 2026-10-22 · D06/D08 검토안

## 1. 목적·책임·범위

편집 데이터와 원본 자산을 로컬 우선으로 저장하고 장애 후 마지막 완료 commit을 복구한다. 로그인 없이 생성·편집·프로젝트 백업·WAV/MIDI 출력이 가능해야 한다. M1은 로컬 저장과 프로젝트 archive, M7은 개인 계정 동기화다. v1 제외: 공동 편집, 자동 semantic merge, 공개 공유, 서버 DSP, 무제한 저장, 사용자 삭제·기기 고장까지 방지하는 로컬 보장.

## 2. 영속 구조와 공개 API

```ts
type Hash = string; // lowercase SHA-256
interface Revision {
  id: Id; projectId: Id; parentIds: Id[]; snapshotHash: Hash;
  assetHashes: Hash[]; editSequence: number; createdAt: string;
}
interface LocalHead { projectId: Id; revisionId: Id; writerEpoch: number }
interface AssetEntry {
  hash: Hash; bytes: number; state: 'staging'|'ready'|'corrupt';
  storage: 'opfs'|'idb'; verifiedAt: string|null;
}
type SaveStatus = 'clean'|'dirty'|'saving'|'saved'|'degraded'|'quota-error'|'read-only';
interface LocalStore {
  open(projectId: Id): Promise<Result<{ project: Project; revision: Revision; missing: Hash[] }>>;
  commit(project: Project, expectedHead: Id|null, editSequence: number): Promise<Result<Revision>>;
  importAsset(bytes: Blob): Promise<Result<AssetEntry>>;
  recover(projectId: Id): Promise<Result<Revision[]>>;
  exportArchive(projectId: Id, revisionId: Id): Promise<Result<Blob>>;
  importArchive(file: Blob): Promise<Result<{ projectId: Id; missing: Hash[] }>>;
}
```

IndexedDB stores: projects(head, remoteHead, sync status), revisions(불변), snapshots(canonical bytes/hash), assets(index/status), journals(recording/import progress), outbox(idempotency key/status), leases(writer epoch). OPFS paths: `/assets/<sha256>`, `/staging/<uuid>`, `/cache/waveforms/<hash>`, `/cache/pcm/<hash-rate-version>`, `/exports/<uuid>`. 경로는 host가 생성하며 archive가 전달한 경로를 그대로 사용하지 않는다. 자산 내용 hash와 Project.asset ID를 분리한다. 자산 hash 공유는 로컬 중복 제거에만 사용하며 계정 간 존재 여부를 노출하지 않는다.

IndexedDB에는 project 전체 JSON과 검색에 필요한 최소 메타데이터만 저장한다. 큰 바이너리는 OPFS에 둔다. OPFS 불가 시 IndexedDB Blob 어댑터를 사용하되 동일 commit protocol을 적용한다. 둘 다 불가하면 메모리 편집과 즉시 백업 출력만 허용하고 저장 성공으로 표시하지 않는다. SAB는 OPFS 일반 사용의 필수 조건이 아니며 sync access handle은 전용 worker의 지원 여부를 별도 탐지한다.

## 3. 로컬 commit 프로토콜

1. project writer lease를 획득하고 현재 head와 expectedHead가 같은지 검사한다.
2. 새 자산을 staging에 스트리밍하고 close/flush 가능한 API로 닫은 뒤 길이·hash를 검증한다.
3. 내용 주소 파일로 promote한다. 원자적 rename이 있다고 가정하지 않는다. copy라면 최종 파일을 다시 검증하고 ready 상태로 등록한다. snapshot에 아직 연결하지 않는다.
4. 02 validate와 canonical serialization 후 snapshot hash를 계산한다. IDB 단일 readwrite transaction에서 snapshot, Revision, asset ready 확인, head CAS, outbox를 함께 기록한다. transaction 중 OPFS IO/network를 await하지 않는다.
5. transaction complete 후에만 saved와 revisionId를 ack한다. 편집 sequence가 앞서 있으면 상태는 dirty를 유지하고 다음 commit을 예약한다.

IDB와 OPFS는 단일 트랜잭션이 아니다. 장애로 orphan asset이 남을 수 있으나 새 head가 불완전 새 asset을 참조하지 않게 한다. 브라우저 또는 파일 손상으로 이미 ready인 자산이 사라지는 경우는 open에서 degraded로 탐지한다. 전원 차단의 물리적 디스크 flush까지 보장하지 않는다. saved는 브라우저 transaction 완료 기준이지 외부 백업 완료가 아니다.

autosave는 마지막 편집 후 1초 debounce, 연속 편집 중 최대 5초 간격, 명시적 Save는 즉시다. pending commit 중 새 편집은 최신 sequence를 별도 유지한다. 탭 종료 unload 이벤트의 저장 성공에 의존하지 않는다. UI는 저장 중/저장됨/미저장/저장 실패를 구별한다. quota 실패는 메모리 편집을 유지하고 캐시만 정리한 뒤 한 번 재시도, 실패 시 백업 출력 경로를 제공한다.

다중 탭: Web Locks API가 있으면 project별 exclusive lock, 없으면 IDB transaction의 lease와 epoch fencing을 사용한다. lease TTL=10초/heartbeat=3초 제안이며 background throttling으로 소유권을 잃은 탭은 read-only로 전환한다. 모든 commit은 epoch와 head를 함께 검사한다. BroadcastChannel은 알림일 뿐 lock이 아니다. 사용자는 다른 탭 takeover를 명시적으로 선택할 수 있으며 기존 탭은 다음 write에서 거절된다.

## 4. 복구·버전·GC·백업

open은 현재 head snapshot을 검증하고 asset의 존재·길이를 확인한다. hash는 첫 import/복원 때 전체 검증하고 이후 suspect/error 시 재검증한다. snapshot 손상은 직전 정상 revision 후보를 제시하며 자동으로 손상 snapshot을 덮어쓰지 않는다. recording journal은 닫힌 segment만 recover 후보로 보여 주고 별도 새 audio source로 합친다. 실패 migration 원본과 미래 버전 파일은 read-only 보존한다.

자동 저장 snapshot은 최근 100개와 최근 24시간의 시간별 1개를 최소 유지한다. 사용자가 pin한 snapshot과 동기화 대기/충돌 revision은 자동 삭제하지 않는다. GC는 모든 retained revision·Undo·recording journal·outbox에서 reachability를 계산한다. staging orphan은 24시간, ready orphan은 7일 유예 후 정지 상태에서 삭제한다. 캐시는 재생성 가능하므로 우선 제거한다. 브라우저 용량 부족 시 보존 규칙을 조용히 낮추지 않고 사용자에게 정리를 제안한다. navigator.storage.persist()는 요청·결과를 기록하지만 허가를 가정하지 않는다.

프로젝트 백업 `.bassdaw`는 ZIP 컨테이너: `manifest.json`, `project.json`, `assets/<sha256>`이다. manifest는 archiveVersion=1, snapshotHash, 각 entry의 bytes/hash, 필요한 plugin ID/version/hash 목록을 담는다. 원본 음원 배포 권한이 불명확한 내장 자산은 archive 포함 정책을 확인한다. 포함하지 못한 자산은 required external로 표시하여 portable complete와 구분한다. 사용자 원본 녹음은 기본 포함한다. 플러그인 실행 파일은 기본 제외다.

archive import는 새 project ID로 복원하고 원본 ID는 metadata originProjectId로 보존한다. 내부 ID는 해당 프로젝트 내부 범위이므로 유지할 수 있다. 기존 프로젝트 덮어쓰기는 별도 명시적 replace 작업에서만 허용한다. ZIP path traversal/absolute path/symlink 거절, compressed 1GiB/uncompressed 2GiB/entry 10,000/압축비 100배 한도, 02 JSON 한도를 함께 적용한다. 큰 합법적 프로젝트는 향후 multipart archive ADR 대상이며 v1에서 부분 성공으로 표시하지 않는다. 모든 entry 검증과 새 로컬 commit 성공 후 import 완료다.

PWA는 최초 실행·앱 shell·선택한 음원팩 캐시 완료 후 오프라인 사용 가능이다. 최초 방문 자체가 오프라인이어도 설치된 것처럼 약속하지 않는다. 서비스워커는 hash 버전 shell을 준비한 후 사용자 유휴 상태에서 전환한다. 재생/녹음 중 강제 reload 금지, DB migration은 writer lock과 원본 백업 필요다. 기본 개발 서버는 Pi에서 실행하지만 secure context가 필요한 크롬북 접속은 HTTPS 터널/인증된 원격 환경을 사용한다. Pi 전원 종료 후에도 배포된 Cloudflare 서비스와 이미 캐시된 로컬 프로젝트는 동작해야 한다.

## 5. 클라우드 구조·API 계약

Workers는 인증·인가·업로드 허가·commit만 담당하고 원본 오디오 렌더링을 하지 않는다. D1에는 owners/projects/head/revisions/assets index/idempotency/tombstones, R2 private bucket에는 immutable snapshot과 원본 자산을 저장한다. D1에 대형 프로젝트 JSON을 그대로 row로 저장하지 않는다.

```ts
interface RemoteCommitRequest {
  projectId: Id; revision: Revision;
  expectedRemoteHead: Id|null; idempotencyKey: Id;
}
type RemoteCommitResponse =
  { status: 'committed'; remoteHead: Id } |
  { status: 'conflict'; remoteHead: Id; retainedRevision: Id|null };
interface SyncStatus {
  state: 'local-only'|'idle'|'queued'|'uploading'|'committing'|'synced'|
    'conflict'|'auth-required'|'offline'|'error';
  localHead: Id; remoteHead: Id|null; pendingBytes: number;
}
```

| Endpoint | 입력·출력 | 조건 |
|---|---|---|
| GET /v1/projects | 소유한 project id/head/tombstone 목록 | 로그인 필수, 페이지네이션 |
| GET /v1/projects/:id/head | head+revision manifest | owner만, 캐시로 CAS 판단 금지 |
| POST /v1/projects/:id/uploads | asset/snapshot hash·bytes·type→제한 URL | 소유권/용량/개수 검사 |
| POST /v1/projects/:id/uploads/:uploadId/complete | 업로드 식별자→verified ready | 서버에서 bytes/hash 검증 완료 필요 |
| POST /v1/projects/:id/commits | RemoteCommitRequest→CAS 결과 | ready 객체만 참조, 중복키 재전송 동일 결과 |
| GET /v1/projects/:id/revisions/:rev | manifest+제한 read URLs | 소유권 매번 확인 |
| POST /v1/projects/:id/branches | 충돌 local revision 보존 | 기존 head 덮어쓰기 금지 |
| DELETE /v1/projects/:id | expected head→tombstone revision | stale이면 409, 즉시 물리 삭제 금지 |
| POST /v1/projects/:id/restore | tombstone/보존 revision→새 head | CAS 필요 |

초기 업로드는 8MiB chunk, asset 1GiB 한도 제안이다. 큰 객체는 multipart upload와 bounded hash verification 작업으로 처리한다. URL 만료 15분, 정확한 object key·method만 허용하며 object key는 계정/project 범위와 hash를 포함한다. 클라이언트가 보낸 hash를 신뢰해 ready로 표시하지 않는다. Workers 실행 제한 내에서 chunk hash를 검증하고 전체 SHA-256은 순차 incremental verifier의 재개 가능한 job으로 확인한다. M7에서 해당 job의 실행·재시도·비용을 검증하기 전 큰 파일 동기화를 출시하지 않는다. 더 작은 upload 한도로 출하하려면 D08에서 명시적으로 승인한다.

로그인 공급자는 D07에서 결정한다. 모든 API는 인증 세션을 ownerId로 해석하고 request의 ownerId는 믿지 않는다. CSRF 방어(쿠키 세션이면 SameSite+CSRF token+Origin 검사), CORS allowlist, 짧은 URL, 서버 secret 관리, 계정별 quota/rate limit을 필수로 한다. R2 key/서비스 자격증명은 브라우저·project JSON에 두지 않는다. 로그아웃은 로컬 프로젝트를 삭제하지 않고 클라우드 세션만 종료한다. 계정 전환 시 이전 계정 outbox를 새 계정으로 전송하지 않는다. 로컬 프로젝트의 최초 업로드 연결은 사용자가 선택한다.

## 6. 동기화·충돌 상태 전이

local-only→사용자 동기화 선택→queued→uploading→committing→synced. 네트워크 장애는 offline, 만료 세션은 auth-required, CAS 불일치는 conflict다. outbox는 IndexedDB commit과 함께 기록해 재시작 후 재개한다. 재시도는 1/2/4/8/16/30/60초 상한+jitter, idempotencyKey를 유지한다. key 재사용 시 payload hash가 다르면 409이다. 429의 Retry-After를 따른다.

R2 업로드·검증 완료→D1 revision 삽입 및 head CAS→응답 순서다. D1 batch 트랜잭션은 D1 내부만 원자적이다. CAS는 `head=expected` 조건으로 단일 transaction에서 실행하고 affected row가 1일 때만 성공 처리한다. 논리적 CAS 실패가 SQL exception처럼 자동 rollback된다고 가정하지 않는다. 실패한 candidate revision은 unheaded branch로 보존하거나 transaction 내에서 명시적으로 제외한다. snapshot R2 orphan은 발생 가능하며 GC 대상이다. 이미 기록된 idempotency 응답이 있으면 그 결과를 그대로 반환한다. 동시에 두 writer가 같은 expected head를 보내도 한 head만 성공해야 한다.

충돌 시 현재 local head·remote head·공통 base를 모두 보존한다. v1 UI 선택은 (1) 로컬을 새 프로젝트/분기로 저장 (2) 원격 사본 열기 (3) 사용자가 두 사본을 비교해 수동 병합이다. last-write-wins와 자동 트랙 병합은 금지다. remote를 선택해도 로컬 분기는 삭제하지 않는다. 삭제도 tombstone revision으로 처리하고 offline edit와 삭제가 충돌하면 자동 삭제하지 않는다.

동기화 성공은 모든 참조 객체 ready+remote head CAS 성공+해당 ack를 로컬에 commit한 상태다. ack 후 클라이언트 crash이면 같은 키로 결과를 조회/재시도한다. 재생/녹음 중 대형 업로드는 낮은 우선순위 또는 일시 정지하고 데이터 처리는 worker에서 수행한다. 클라우드 백업 보존 초깃값은 tombstone 30일, 충돌 분기는 사용자가 정리 전까지 pin 제안이며 비용 D08 승인 필요다.

## 7. 오류·성능·불변조건

QUOTA, LOCAL_HEAD_CHANGED, WRITER_LOST, ASSET_CORRUPT/MISSING, AUTH_REQUIRED, FORBIDDEN, REMOTE_CONFLICT, UPLOAD_EXPIRED, NETWORK, HASH_MISMATCH를 구분한다. 어느 실패도 정상 원본을 지우지 않는다. 로컬 저장 성공과 원격 동기화 성공 UI를 분리한다. cache 정리로 source 파일을 삭제하지 않는다. 원본 SHA는 업로드·archive·복구를 통틀어 동일하다.

기준 fixture의 메타데이터 autosave p95 500ms(자산 신규 쓰기 제외), UI main thread 저장 관련 long task 50ms 초과 0 목표다. 자산 입출력은 streaming/backpressure, 동시 upload 2개 기본, 저사양/재생 중 1개이다. 공급자 quotas·플랜 가격은 배포 직전 공식 문서로 다시 확인하며 무제한 또는 무료 운영을 가정하지 않는다.

## 8. 자동화 수용 테스트

- L01: 비로그인 오프라인 생성→편집→재시작 후 마지막 완료 head/자산 hash 동일.
- L02: commit 1–5 각 경계 crash injection 후 old/new의 온전한 head만 보임.
- L03: quota/OPFS 불가/asset 소실/corrupt snapshot에서 명확한 degraded·실패 표시와 백업.
- L04: 두 탭 takeover·stale epoch·stale head write 거절.
- L05: archive round trip, path traversal/zip bomb/미완료 import는 기존 head 불변.
- C01: 두 device가 같은 remote base로 commit하면 1 success+1 conflict, 두 작업 보존.
- C02: 각 upload/verify/CAS/ack 단계 단절 후 재시도에 중복 head·데이터 손실 0.
- C03: 삭제 vs offline edit, 로그아웃·계정 전환, 만료 URL 안전 복구.
- C04: 다른 user의 project/upload/revision 접근 전부 403 또는 비노출 404.
- C05: hash mismatch 또는 미완료 asset을 참조하는 remote commit 거절.
- C06: GC가 pin/outbox/충돌/Undo/recording 자산을 삭제하지 않음.
- C07: Pi off·네트워크 off에서도 캐시된 로컬 작업·export 가능.

동작 근거는 00의 MDN OPFS/persist 및 Cloudflare D1/R2 공식 문서를 따른다.
