-- 04 §5 D1 스키마: owner 별 projects/head/revisions/objects(asset·snapshot index)/uploads/idempotency/tombstones/branches.
-- project JSON 과 원본 자산은 R2 private bucket 에만 저장한다(D1 에는 hash·크기·상태 같은 작은 메타데이터만).
-- 모든 행은 owner_id 로 분리된다. 다른 owner 의 같은 project id 는 별개의 행이며 서로 보이지 않는다.

CREATE TABLE IF NOT EXISTS owners (
  owner_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  head TEXT,                       -- 현재 remote head revision id (NULL = 아직 commit 없음)
  head_seq INTEGER NOT NULL DEFAULT 0,
  tombstoned_at TEXT,              -- 삭제(tombstone) 시각. 물리 삭제는 하지 않는다.
  purge_after TEXT,                -- 보존 기한 제안(30일, D08 확정 전). MVP-7 은 purge 를 실행하지 않는다.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);

CREATE TABLE IF NOT EXISTS revisions (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- normal | tombstone | restore
  parent_ids TEXT NOT NULL,        -- JSON array
  snapshot_hash TEXT NOT NULL,
  asset_hashes TEXT NOT NULL,      -- JSON array (snapshot 이 참조하는 자산 hash 집합과 같아야 한다)
  edit_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,        -- client 가 보낸 시각(정보용)
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,      -- 같은 id 재전송이 같은 내용인지 비교
  PRIMARY KEY (owner_id, project_id, revision_id)
);

-- head 가 아닌 보존 revision(충돌 candidate, 명시적 보존). 사용자가 정리하기 전까지 pin.
CREATE TABLE IF NOT EXISTS branches (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  reason TEXT NOT NULL,            -- conflict | retained
  base_head TEXT,                  -- candidate 가 기대했던 head
  remote_head TEXT,                -- 당시 실제 head
  pinned INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id, revision_id)
);

-- R2 객체 index. state=ready 인 행만 commit 에서 참조할 수 있다(클라이언트 hash 는 신뢰하지 않음).
CREATE TABLE IF NOT EXISTS objects (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- asset | snapshot
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  state TEXT NOT NULL,             -- pending | verifying | ready | rejected
  r2_key TEXT NOT NULL,
  refs TEXT,                       -- snapshot: 서버가 snapshot 을 파싱해 얻은 asset hash JSON
  created_at TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (owner_id, project_id, kind, hash)
);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  chunk_bytes INTEGER NOT NULL,
  chunk_hashes TEXT NOT NULL,      -- JSON array (chunk 단위 검증용; 최종 판정은 서버의 전체 SHA-256)
  r2_key TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '{}',-- JSON {partNumber: etag}
  state TEXT NOT NULL,             -- pending | verifying | ready | rejected | expired
  verify_state TEXT,               -- JSON {offset, sha} 재개 가능한 incremental verifier 상태
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_owner_project ON uploads (owner_id, project_id, kind, hash, state);
CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads (state, expires_at);

-- 중복키 결과 재사용. 같은 key + 다른 request_hash 는 409.
CREATE TABLE IF NOT EXISTS idempotency (
  owner_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  op TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,          -- JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, idem_key)
);

CREATE TABLE IF NOT EXISTS tombstones (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,       -- tombstone revision
  deleted_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  restored_at TEXT,
  PRIMARY KEY (owner_id, project_id, revision_id)
);

-- 계정별 rate limit(분 단위 고정 창)
CREATE TABLE IF NOT EXISTS rate (
  owner_id TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (owner_id, window)
);
