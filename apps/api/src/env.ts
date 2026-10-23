// Workers 바인딩과 설정. D1/R2 는 이 Worker 가 쓰는 부분 집합만 선언한다(Node 로컬 어댑터도 같은 계약을 구현).
// 실제 Cloudflare 런타임에서는 @cloudflare/workers-types 의 D1Database/R2Bucket 이 이 구조를 만족한다.

export interface D1Result<T = Record<string, unknown>> { results: T[]; success: boolean; meta: { changes: number; last_row_id: number } }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** 하나의 SQL transaction. 한 statement 라도 실패하면 전체 rollback 후 throw. (R2 는 포함되지 않는다) */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<unknown>;
}

export interface R2Object { key: string; size: number; etag: string; uploaded: Date }
export interface R2ObjectBody extends R2Object { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }
export interface R2UploadedPart { partNumber: number; etag: string }
export interface R2MultipartUpload {
  readonly key: string; readonly uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
  abort(): Promise<void>;
}
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  /** onlyIf 실패 시 body 없는 R2Object(실제 R2 계약), 없으면 null */
  get(key: string, opts?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } }): Promise<R2ObjectBody | R2Object | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>): Promise<R2Object>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** 'none'(공급자 미설정, 기본) | 'fake'(로컬 개발 전용). 실제 공급자는 D07 선택 후 추가한다. */
  AUTH_MODE?: string;
  /** 'production'(기본) | 'development'. fake auth 는 development + localhost 에서만 허용. */
  ENVIRONMENT?: string;
  FAKE_AUTH_SECRET?: string;
  /** 제한 URL 서명 키(서버 secret). 브라우저·project JSON 에 두지 않는다. */
  SIGNING_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  // 한도(D08 확정 전 제안값 — 실제 배포 전 사용자 승인 필요)
  CHUNK_BYTES?: string;
  MAX_ASSET_BYTES?: string;
  QUOTA_BYTES?: string;
  MAX_OBJECTS?: string;
  URL_TTL_SEC?: string;
  UPLOAD_TTL_SEC?: string;
  VERIFY_BUDGET_BYTES?: string;
  RATE_LIMIT_PER_MIN?: string;
  TOMBSTONE_RETENTION_DAYS?: string;
  /** 테스트 전용(프로그램으로만 주입 가능한 함수 값 — wrangler vars 로는 만들 수 없다) */
  __now?: () => number;
  __beforeCas?: (op: string) => Promise<void>;
}

export interface Config {
  authMode: 'none' | 'fake';
  development: boolean;
  chunkBytes: number; maxAssetBytes: number; maxSnapshotBytes: number; quotaBytes: number; maxObjects: number;
  urlTtlMs: number; uploadTtlMs: number; verifyBudgetBytes: number; ratePerMin: number; tombstoneMs: number;
  origins: string[];
  signingSecret: string;
}

export const MiB = 1024 * 1024;
export const PLACEHOLDER_SECRETS = new Set(['', 'replace-with-random-local-secret', 'changeme', 'change-me', 'secret']);

const num = (v: string | undefined, d: number) => { const n = v === undefined || v === '' ? d : Number(v); if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`bad numeric config ${v}`); return n; };

export class ConfigError extends Error {}

/**
 * 설정 검증. fake auth production 방어(3중):
 *  1) AUTH_MODE=fake 는 ENVIRONMENT=development 에서만, 2) 요청 host 가 localhost/127.0.0.1/[::1] 일 때만,
 *  3) FAKE_AUTH_SECRET 이 placeholder 가 아니고 16자 이상일 때만. 하나라도 어기면 모든 요청을 거절한다.
 *  wrangler.toml 의 기본값은 AUTH_MODE="none", ENVIRONMENT="production" 이며 fake 값은 .dev.vars(로컬·gitignore)에만 둔다.
 */
export function loadConfig(env: Env, url: URL): Config {
  const mode = env.AUTH_MODE ?? 'none';
  if (mode !== 'none' && mode !== 'fake') throw new ConfigError(`AUTH_MODE ${mode} is not implemented (D07: provider not chosen)`);
  const development = env.ENVIRONMENT === 'development';
  if (mode === 'fake') {
    if (!development) throw new ConfigError('fake auth is development-only (ENVIRONMENT must be "development")');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new ConfigError(`fake auth only on localhost (got ${url.hostname})`);
    if (PLACEHOLDER_SECRETS.has(env.FAKE_AUTH_SECRET ?? '') || (env.FAKE_AUTH_SECRET ?? '').length < 16) throw new ConfigError('FAKE_AUTH_SECRET missing or placeholder');
  }
  const signingSecret = env.SIGNING_SECRET ?? '';
  if (PLACEHOLDER_SECRETS.has(signingSecret) || signingSecret.length < 16) throw new ConfigError('SIGNING_SECRET missing or placeholder');
  const chunkBytes = num(env.CHUNK_BYTES, 8 * MiB);
  // 실제 R2 multipart 는 마지막 part 외 5MiB 이상이 필요하다. 작은 chunk 는 로컬 테스트 전용.
  if (!development && chunkBytes < 5 * MiB) throw new ConfigError('CHUNK_BYTES < 5MiB is only allowed in development');
  return {
    authMode: mode, development, chunkBytes,
    maxAssetBytes: num(env.MAX_ASSET_BYTES, 1024 * MiB),
    maxSnapshotBytes: 32 * MiB, // 02 JSON 한도
    quotaBytes: num(env.QUOTA_BYTES, 1024 * MiB),
    maxObjects: num(env.MAX_OBJECTS, 10_000),
    urlTtlMs: num(env.URL_TTL_SEC, 15 * 60) * 1000,
    uploadTtlMs: num(env.UPLOAD_TTL_SEC, 24 * 3600) * 1000,
    verifyBudgetBytes: num(env.VERIFY_BUDGET_BYTES, 64 * MiB),
    ratePerMin: num(env.RATE_LIMIT_PER_MIN, 600),
    tombstoneMs: num(env.TOMBSTONE_RETENTION_DAYS, 30) * 86_400_000,
    origins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    signingSecret,
  };
}
