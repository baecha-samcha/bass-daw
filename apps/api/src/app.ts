// bass-daw 동기화 API (04 §5–6). Workers 는 인증·인가·업로드 허가·검증·commit 만 담당하고 오디오를 렌더링하지 않는다.
// 순서 불변조건: R2 업로드 → 서버 검증(ready) → D1 revision 삽입 + head CAS(단일 batch) → 응답.
// D1 batch 는 D1 내부만 원자적이다(R2 미포함). R2 orphan 은 GC 대상이다.
import { Sha256, deserializeProject } from '@bass-daw/schemas';
import { loadConfig, ConfigError, type Config, type Env } from './env.ts';
import { authAdapter, fakeLogin, type Session } from './auth.ts';
import { ApiError, json, errorResponse, corsHeaders, readJson, signToken, verifyToken, sha256, needId, needHash, HASH_RE } from './http.ts';

interface Ctx { env: Env; cfg: Config; now: () => number; session: Session | null; origin: string }

const iso = (t: number) => new Date(t).toISOString();
const ownerKey = (o: string) => encodeURIComponent(o);
/**
 * R2 key 는 업로드마다 고유하다(…/<hash>/<uploadId>). 같은 hash 의 다른 업로드가 검증 중이거나 ready 인 객체를 덮어쓸 수 없다.
 * ready 객체는 (r2_key, etag) 로 고정되며 이후 읽기는 onlyIf.etagMatches 로 같은 버전만 허용한다(decisions/0011).
 */
export const objectKey = (owner: string, project: string, kind: string, hash: string, uploadId: string) => `o/${ownerKey(owner)}/${project}/${kind}/${hash}/${uploadId}`;

/** etag 고정 읽기. 객체가 없거나 다른 버전이면 null(R2: precondition 실패 시 body 없는 R2Object 반환). */
async function pinnedGet(env: Env, key: string, etag: string, range?: { offset: number; length: number }) {
  const o = await env.BUCKET.get(key, { onlyIf: { etagMatches: etag }, ...(range ? { range } : {}) });
  return o && 'body' in o && o.body ? o : null;
}

/** 키 정렬 JSON (idempotency payload hash 용) */
export function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');
  let cfg: Config;
  try { cfg = loadConfig(env, url); }
  catch (e) {
    // 설정 거절(fake auth production 방어 포함): CORS 헤더 없이 모든 요청 거절
    return json({ error: 'CONFIG_REFUSED', message: e instanceof ConfigError ? e.message : 'config error' }, 500);
  }
  const cors = corsHeaders(origin, cfg);
  const finish = (r: Response) => { for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; };
  if (origin && !cfg.origins.includes(origin)) return errorResponse(new ApiError(403, 'ORIGIN_FORBIDDEN', `origin ${origin} is not allowed`));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const now = () => env.__now?.() ?? Date.now();
  try {
    return finish(await route(req, url, { env, cfg, now, session: null, origin: url.origin }));
  } catch (e) {
    if (e instanceof ApiError) return finish(errorResponse(e));
    return finish(json({ error: 'INTERNAL', message: 'internal error' }, 500));
  }
}

async function route(req: Request, url: URL, c: Ctx): Promise<Response> {
  const p = url.pathname.split('/').filter(Boolean);
  const m = req.method;
  if (p[0] !== 'v1') throw new ApiError(404, 'NOT_FOUND', 'not found');
  if (p[1] === 'health' && m === 'GET') return json({ ok: true, authMode: c.cfg.authMode, environment: c.cfg.development ? 'development' : 'production' });
  if (p[1] === 'config' && m === 'GET') return json({ chunkBytes: c.cfg.chunkBytes, maxAssetBytes: c.cfg.maxAssetBytes, maxSnapshotBytes: c.cfg.maxSnapshotBytes, urlTtlSec: c.cfg.urlTtlMs / 1000, authMode: c.cfg.authMode });
  if (p[1] === 'dev' && p[2] === 'login' && m === 'POST') return json(await fakeLogin(c.env, c.cfg, await readJson(req, 4096), c.now()));
  if (p[1] === 'dev' && p[2] === 'gc' && m === 'POST') { if (!c.cfg.development) throw new ApiError(404, 'NOT_FOUND', 'not found'); return json(await gc(c.env, c.now())); }

  c.session = await authAdapter(c.env, c.cfg, c.now).resolve(req);
  if (!c.session) throw new ApiError(401, 'AUTH_REQUIRED', 'login required or session expired');
  await rateLimit(c);
  const owner = c.session.ownerId;

  if (p[1] === 'chunks' && p[2] && m === 'PUT') return putChunk(req, c, p[2]);
  if (p[1] === 'blobs' && p[2] && m === 'GET') return getBlob(c, p[2]);
  if (p[1] !== 'projects') throw new ApiError(404, 'NOT_FOUND', 'not found');
  if (p.length === 2 && m === 'GET') return listProjects(c, url);
  const projectId = needId(p[2], 'projectId');
  if (p.length === 3 && m === 'DELETE') return deleteProject(req, c, projectId);
  if (p[3] === 'head' && m === 'GET') return getHead(c, projectId);
  if (p[3] === 'uploads') {
    if (p.length === 4 && m === 'POST') return createUpload(req, c, projectId);
    const uploadId = needId(p[4], 'uploadId');
    if (p.length === 5 && m === 'GET') return uploadStatus(c, projectId, uploadId);
    if (p[5] === 'complete' && m === 'POST') return completeUpload(c, projectId, uploadId);
  }
  if (p[3] === 'commits' && m === 'POST') return commit(req, c, projectId);
  if (p[3] === 'revisions' && p[4] && m === 'GET') return getRevision(c, projectId, needId(p[4], 'revisionId'));
  if (p[3] === 'branches' && m === 'GET') return listBranches(c, projectId);
  if (p[3] === 'branches' && m === 'POST') return retainBranch(req, c, projectId);
  if (p[3] === 'restore' && m === 'POST') return restore(req, c, projectId);
  void owner;
  throw new ApiError(404, 'NOT_FOUND', 'not found');
}

// ---------------- rate limit / quota ----------------
async function rateLimit(c: Ctx) {
  const t = c.now(); const window = Math.floor(t / 60_000);
  const r = await c.env.DB.prepare('INSERT INTO rate (owner_id, window, count) VALUES (?1, ?2, 1) ON CONFLICT (owner_id, window) DO UPDATE SET count = count + 1 RETURNING count').bind(c.session!.ownerId, window).first<{ count: number }>();
  if ((r?.count ?? 0) > c.cfg.ratePerMin) throw new ApiError(429, 'RATE_LIMITED', 'too many requests', { retryAfterSec: Math.max(1, Math.ceil(((window + 1) * 60_000 - t) / 1000)) });
}

// ---------------- projects ----------------
interface ProjectRow { project_id: string; head: string | null; head_seq: number; tombstoned_at: string | null; purge_after: string | null; updated_at: string }
interface RevisionRow { revision_id: string; project_id: string; kind: string; parent_ids: string; snapshot_hash: string; asset_hashes: string; edit_sequence: number; created_at: string; payload_hash: string }

const projectRow = (c: Ctx, id: string) => c.env.DB.prepare('SELECT project_id, head, head_seq, tombstoned_at, purge_after, updated_at FROM projects WHERE owner_id = ?1 AND project_id = ?2').bind(c.session!.ownerId, id).first<ProjectRow>();
const revisionRow = (c: Ctx, project: string, rev: string) => c.env.DB.prepare('SELECT * FROM revisions WHERE owner_id = ?1 AND project_id = ?2 AND revision_id = ?3').bind(c.session!.ownerId, project, rev).first<RevisionRow>();
const manifest = (r: RevisionRow) => ({ id: r.revision_id, projectId: r.project_id, kind: r.kind, parentIds: JSON.parse(r.parent_ids) as string[], snapshotHash: r.snapshot_hash, assetHashes: JSON.parse(r.asset_hashes) as string[], editSequence: r.edit_sequence, createdAt: r.created_at });

/** 다른 owner 의 project 는 존재 자체를 노출하지 않는다(비노출 404) */
async function ownedProject(c: Ctx, id: string): Promise<ProjectRow> {
  const r = await projectRow(c, id);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'project not found');
  return r;
}

async function listProjects(c: Ctx, url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
  const cursor = url.searchParams.get('cursor') ?? '';
  const rows = (await c.env.DB.prepare('SELECT project_id, head, head_seq, tombstoned_at, purge_after, updated_at FROM projects WHERE owner_id = ?1 AND project_id > ?2 ORDER BY project_id LIMIT ?3').bind(c.session!.ownerId, cursor, limit + 1).all<ProjectRow>()).results;
  const page = rows.slice(0, limit);
  return json({ projects: page.map((r) => ({ id: r.project_id, head: r.head, tombstoned: !!r.tombstoned_at, deletedAt: r.tombstoned_at, purgeAfter: r.purge_after, updatedAt: r.updated_at })), next: rows.length > limit ? page[page.length - 1].project_id : null });
}

async function getHead(c: Ctx, id: string) {
  const p = await ownedProject(c, id);
  const rev = p.head ? await revisionRow(c, id, p.head) : null;
  return json({ projectId: id, head: p.head, tombstoned: !!p.tombstoned_at, purgeAfter: p.purge_after, revision: rev ? manifest(rev) : null });
}

async function getRevision(c: Ctx, projectId: string, revId: string) {
  await ownedProject(c, projectId);
  const r = await revisionRow(c, projectId, revId);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'revision not found');
  const mf = manifest(r);
  const exp = c.now() + c.cfg.urlTtlMs;
  const dl = (kind: string, h: string) => signToken(c.cfg.signingSecret, 'dl1', { o: c.session!.ownerId, p: projectId, k: kind, h, exp }).then((t) => `${c.origin}/v1/blobs/${t}`);
  const assets: Record<string, string> = {};
  for (const h of mf.assetHashes) assets[h] = await dl('asset', h);
  return json({ revision: mf, urls: { snapshot: await dl('snapshot', mf.snapshotHash), assets }, expiresAt: exp });
}

async function getBlob(c: Ctx, token: string) {
  const t = await verifyToken<{ o: string; p: string; k: string; h: string; exp: number }>(c.cfg.signingSecret, 'dl1', token);
  if (!t) throw new ApiError(403, 'FORBIDDEN', 'invalid URL');
  if (t.exp < c.now()) throw new ApiError(403, 'UPLOAD_EXPIRED', 'URL expired');
  if (t.o !== c.session!.ownerId) throw new ApiError(403, 'FORBIDDEN', 'URL belongs to another account');
  const o = await c.env.DB.prepare("SELECT r2_key, bytes, etag FROM objects WHERE owner_id = ?1 AND project_id = ?2 AND kind = ?3 AND hash = ?4 AND state = 'ready'").bind(t.o, t.p, t.k, t.h).first<{ r2_key: string; bytes: number; etag: string | null }>();
  if (!o || !o.etag) throw new ApiError(404, 'NOT_FOUND', 'object not found');
  // 검증한 바로 그 객체 버전만 내보낸다. 바뀌었으면(손상·외부 덮어쓰기) 바이트를 주지 않는다.
  const obj = await pinnedGet(c.env, o.r2_key, o.etag);
  if (!obj || obj.size !== o.bytes) throw new ApiError(409, 'OBJECT_CHANGED', 'stored object differs from the verified version; re-upload required');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size), 'x-content-sha256': t.h, 'cache-control': 'private, no-store' } });
}

async function listBranches(c: Ctx, projectId: string) {
  await ownedProject(c, projectId);
  const rows = (await c.env.DB.prepare('SELECT revision_id, reason, base_head, remote_head, pinned, created_at FROM branches WHERE owner_id = ?1 AND project_id = ?2 ORDER BY created_at').bind(c.session!.ownerId, projectId).all()).results;
  return json({ branches: rows });
}

// ---------------- uploads ----------------
interface UploadRow { upload_id: string; owner_id: string; project_id: string; kind: string; hash: string; bytes: number; chunk_bytes: number; chunk_hashes: string; r2_key: string; r2_upload_id: string; parts: string; state: string; verify_state: string | null; expires_at: number }

const chunkCount = (bytes: number, chunk: number) => Math.ceil(bytes / chunk);
const chunkLen = (u: { bytes: number; chunk_bytes: number }, n: number) => Math.min(u.chunk_bytes, u.bytes - n * u.chunk_bytes);

async function chunkUrls(c: Ctx, u: UploadRow) {
  const have = JSON.parse(u.parts) as Record<string, string>;
  const exp = c.now() + c.cfg.urlTtlMs;
  const out: { n: number; bytes: number; url: string; expiresAt: number }[] = [];
  for (let n = 0; n < chunkCount(u.bytes, u.chunk_bytes); n++) {
    if (have[String(n + 1)]) continue;
    // 제한 URL: 정확한 upload·part·method·owner·만료를 서명. 인증 세션도 함께 요구한다.
    const t = await signToken(c.cfg.signingSecret, 'up1', { u: u.upload_id, n, o: u.owner_id, m: 'PUT', exp });
    out.push({ n, bytes: chunkLen(u, n), url: `${c.origin}/v1/chunks/${t}`, expiresAt: exp });
  }
  return out;
}

async function uploadById(c: Ctx, projectId: string, uploadId: string): Promise<UploadRow> {
  const u = await c.env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?1').bind(uploadId).first<UploadRow>();
  if (!u || u.owner_id !== c.session!.ownerId || u.project_id !== projectId) throw new ApiError(404, 'NOT_FOUND', 'upload not found');
  return u;
}

async function createUpload(req: Request, c: Ctx, projectId: string) {
  const b = await readJson<{ kind?: unknown; hash?: unknown; bytes?: unknown; chunkBytes?: unknown; chunkHashes?: unknown }>(req, 1024 * 1024);
  const owner = c.session!.ownerId;
  const kind = b.kind === 'asset' || b.kind === 'snapshot' ? b.kind : (() => { throw new ApiError(400, 'BAD_REQUEST', 'kind must be asset|snapshot'); })();
  const hash = needHash(b.hash, 'hash');
  const bytes = Number(b.bytes);
  const limit = kind === 'snapshot' ? c.cfg.maxSnapshotBytes : c.cfg.maxAssetBytes;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new ApiError(400, 'BAD_REQUEST', 'bytes must be a positive integer');
  if (bytes > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `${kind} > ${limit} bytes`);
  if (b.chunkBytes !== c.cfg.chunkBytes) throw new ApiError(400, 'BAD_REQUEST', `chunkBytes must be ${c.cfg.chunkBytes} (GET /v1/config)`);
  const hashes = Array.isArray(b.chunkHashes) ? b.chunkHashes : [];
  if (hashes.length !== chunkCount(bytes, c.cfg.chunkBytes) || !hashes.every((h) => typeof h === 'string' && HASH_RE.test(h))) throw new ApiError(400, 'BAD_REQUEST', 'chunkHashes must list one sha256 per chunk');
  // 같은 계정·project 안에서만 중복 제거(계정 간 존재 여부 비노출)
  const ready = await c.env.DB.prepare("SELECT 1 AS x FROM objects WHERE owner_id = ?1 AND project_id = ?2 AND kind = ?3 AND hash = ?4 AND state = 'ready'").bind(owner, projectId, kind, hash).first();
  if (ready) return json({ state: 'ready', kind, hash });
  const t = c.now();
  const open = await c.env.DB.prepare("SELECT * FROM uploads WHERE owner_id = ?1 AND project_id = ?2 AND kind = ?3 AND hash = ?4 AND state IN ('pending', 'verifying') AND expires_at > ?5").bind(owner, projectId, kind, hash, t).first<UploadRow>();
  if (open && open.chunk_hashes === JSON.stringify(hashes)) {
    // 재개: 이미 받은 part 는 제외한 제한 URL 을 새로 발급
    return json({ uploadId: open.upload_id, state: open.state, chunkBytes: open.chunk_bytes, chunks: await chunkUrls(c, open) });
  }
  if (open) await abortUpload(c.env, open, 'rejected');
  const q = await c.env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM (SELECT bytes FROM objects WHERE owner_id = ?1 AND state = 'ready' UNION ALL SELECT bytes FROM uploads WHERE owner_id = ?1 AND state IN ('pending', 'verifying') AND expires_at > ?2)").bind(owner, t).first<{ bytes: number; n: number }>();
  if ((q?.bytes ?? 0) + bytes > c.cfg.quotaBytes || (q?.n ?? 0) + 1 > c.cfg.maxObjects) throw new ApiError(413, 'QUOTA', 'account storage quota exceeded', { usedBytes: q?.bytes ?? 0, quotaBytes: c.cfg.quotaBytes });
  const uploadId = crypto.randomUUID();
  const key = objectKey(owner, projectId, kind, hash, uploadId);
  const mp = await c.env.BUCKET.createMultipartUpload(key);
  await c.env.DB.prepare("INSERT INTO uploads (upload_id, owner_id, project_id, kind, hash, bytes, chunk_bytes, chunk_hashes, r2_key, r2_upload_id, parts, state, verify_state, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '{}', 'pending', NULL, ?11, ?12, ?12)")
    .bind(uploadId, owner, projectId, kind, hash, bytes, c.cfg.chunkBytes, JSON.stringify(hashes), key, mp.uploadId, t + c.cfg.uploadTtlMs, iso(t)).run();
  const u = (await c.env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?1').bind(uploadId).first<UploadRow>())!;
  return json({ uploadId, state: 'pending', chunkBytes: c.cfg.chunkBytes, chunks: await chunkUrls(c, u) }, 201);
}

async function putChunk(req: Request, c: Ctx, token: string) {
  const t = await verifyToken<{ u: string; n: number; o: string; m: string; exp: number }>(c.cfg.signingSecret, 'up1', token);
  if (!t || t.m !== 'PUT') throw new ApiError(403, 'FORBIDDEN', 'invalid upload URL');
  if (t.exp < c.now()) throw new ApiError(403, 'UPLOAD_EXPIRED', 'upload URL expired — request fresh URLs');
  if (t.o !== c.session!.ownerId) throw new ApiError(403, 'FORBIDDEN', 'upload URL belongs to another account');
  const u = await c.env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?1').bind(t.u).first<UploadRow>();
  if (!u || u.owner_id !== t.o) throw new ApiError(404, 'NOT_FOUND', 'upload not found');
  if (u.state !== 'pending') throw new ApiError(409, 'UPLOAD_INCOMPLETE', `upload is ${u.state}`, { state: u.state });
  if (u.expires_at < c.now()) throw new ApiError(410, 'UPLOAD_EXPIRED', 'upload intent expired');
  const want = chunkLen(u, t.n);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length !== want) throw new ApiError(400, 'BAD_REQUEST', `chunk ${t.n} must be ${want} bytes (got ${body.length})`);
  // chunk 단위 검증(Workers 실행 제한 내). 최종 ready 판정은 complete 의 전체 SHA-256 검증이다.
  if (await sha256(body) !== (JSON.parse(u.chunk_hashes) as string[])[t.n]) throw new ApiError(422, 'HASH_MISMATCH', `chunk ${t.n} hash mismatch`, { chunk: t.n });
  const part = await c.env.BUCKET.resumeMultipartUpload(u.r2_key, u.r2_upload_id).uploadPart(t.n + 1, body);
  await c.env.DB.prepare("UPDATE uploads SET parts = json_set(parts, '$.\"' || ?1 || '\"', ?2), updated_at = ?3 WHERE upload_id = ?4").bind(String(t.n + 1), part.etag, iso(c.now()), u.upload_id).run();
  return json({ ok: true, n: t.n });
}

async function uploadStatus(c: Ctx, projectId: string, uploadId: string) {
  const u = await uploadById(c, projectId, uploadId);
  const vs = u.verify_state ? JSON.parse(u.verify_state) as { offset: number } : null;
  const received = Object.keys(JSON.parse(u.parts)).map((k) => Number(k) - 1).sort((a, b) => a - b);
  const live = u.state === 'pending' && u.expires_at > c.now();
  return json({ uploadId, state: u.state === 'pending' && !live ? 'expired' : u.state, bytes: u.bytes, received, verifiedBytes: vs?.offset ?? 0, chunks: live ? await chunkUrls(c, u) : [] });
}

async function abortUpload(env: Env, u: UploadRow, state: 'rejected' | 'expired') {
  try { await env.BUCKET.resumeMultipartUpload(u.r2_key, u.r2_upload_id).abort(); } catch { /* 이미 complete 되었거나 없음 */ }
  // 업로드별 key 이므로 ready 객체(다른 key)를 지울 위험이 없다. 이 업로드가 만든 미검증 객체만 제거.
  const ready = await env.DB.prepare("SELECT 1 AS x FROM objects WHERE r2_key = ?1 AND state = 'ready'").bind(u.r2_key).first();
  if (!ready) await env.BUCKET.delete(u.r2_key);
  await env.DB.prepare('UPDATE uploads SET state = ?1, updated_at = ?2 WHERE upload_id = ?3').bind(state, new Date().toISOString(), u.upload_id).run();
}

/**
 * complete: 모든 part 수신 확인 → multipart complete → bounded incremental SHA-256 job.
 * 한 호출은 VERIFY_BUDGET_BYTES 까지만 읽고 상태를 D1 에 저장한다. 끝나지 않으면 202 verifying(같은 호출로 재개).
 * 서버가 계산한 hash·길이가 일치할 때만 ready. snapshot 은 추가로 02 검증과 참조 자산 목록을 서버가 추출한다.
 */
async function completeUpload(c: Ctx, projectId: string, uploadId: string) {
  let u = await uploadById(c, projectId, uploadId);
  if (u.state === 'ready') return json({ state: 'ready', kind: u.kind, hash: u.hash });
  if (u.state === 'rejected') throw new ApiError(422, 'HASH_MISMATCH', 'upload was rejected by server verification');
  if (u.state === 'expired' || (u.state === 'pending' && u.expires_at < c.now())) throw new ApiError(410, 'UPLOAD_EXPIRED', 'upload intent expired — start a new upload');
  if (u.state === 'pending') {
    const have = JSON.parse(u.parts) as Record<string, string>;
    const total = chunkCount(u.bytes, u.chunk_bytes);
    const missing = Array.from({ length: total }, (_, n) => n).filter((n) => !have[String(n + 1)]);
    if (missing.length) throw new ApiError(409, 'UPLOAD_INCOMPLETE', `${missing.length} chunk(s) missing`, { missing });
    const done = await c.env.BUCKET.resumeMultipartUpload(u.r2_key, u.r2_upload_id).complete(Array.from({ length: total }, (_, n) => ({ partNumber: n + 1, etag: have[String(n + 1)] })));
    // 검증 대상 버전 = complete 가 돌려준 객체의 etag. 이후 모든 range read 는 이 etag 로 고정한다.
    const vs = JSON.stringify({ offset: 0, sha: new Sha256().exportState(), etag: done.etag });
    await c.env.DB.prepare("UPDATE uploads SET state = 'verifying', verify_state = ?1, updated_at = ?2 WHERE upload_id = ?3 AND state = 'pending'").bind(vs, iso(c.now()), u.upload_id).run();
    u = (await c.env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?1').bind(uploadId).first<UploadRow>())!;
  }
  const st = JSON.parse(u.verify_state!) as { offset: number; sha: { h: number[]; buf: string; total: number }; etag: string };
  const head = await c.env.BUCKET.head(u.r2_key);
  if (!head || head.etag !== st.etag) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'OBJECT_CHANGED', 'object changed or disappeared during verification'); }
  if (head.size !== u.bytes) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'HASH_MISMATCH', `stored size ${head.size} != declared ${u.bytes}`); }
  const sha = Sha256.fromState(st.sha);
  let offset = st.offset, budget = c.cfg.verifyBudgetBytes;
  while (offset < u.bytes && budget > 0) {
    const len = Math.min(u.chunk_bytes, u.bytes - offset, budget);
    const part = await pinnedGet(c.env, u.r2_key, st.etag, { offset, length: len });
    if (!part) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'OBJECT_CHANGED', 'object changed during verification'); }
    const buf = new Uint8Array(await part.arrayBuffer());
    if (buf.length !== len) throw new ApiError(503, 'DB_ERROR', 'short read; retry');
    sha.update(buf); offset += len; budget -= len;
  }
  if (offset < u.bytes) {
    await c.env.DB.prepare("UPDATE uploads SET verify_state = ?1, updated_at = ?2 WHERE upload_id = ?3 AND state = 'verifying'").bind(JSON.stringify({ offset, sha: sha.exportState(), etag: st.etag }), iso(c.now()), u.upload_id).run();
    return json({ state: 'verifying', verifiedBytes: offset, bytes: u.bytes }, 202);
  }
  const digest = sha.digestHex();
  if (digest !== u.hash) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'HASH_MISMATCH', 'server-computed SHA-256 differs from the declared hash'); }
  let refs: string | null = null;
  if (u.kind === 'snapshot') {
    const obj = await pinnedGet(c.env, u.r2_key, st.etag);
    if (!obj) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'OBJECT_CHANGED', 'object changed during verification'); }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (await sha256(bytes) !== u.hash) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'HASH_MISMATCH', 'snapshot bytes differ from the verified hash'); }
    const d = deserializeProject(bytes);
    if (!d.ok || d.value.id !== projectId) { await abortUpload(c.env, u, 'rejected'); throw new ApiError(422, 'REVISION_MISMATCH', d.ok ? 'snapshot belongs to another project id' : `snapshot invalid: ${d.errors[0].code}`); }
    refs = JSON.stringify([...new Set(d.value.assets.map((a) => a.sha256))].sort());
  }
  const t = iso(c.now());
  // 같은 hash 의 ready 객체가 이미 있으면 그것을 유지하고(먼저 검증된 버전) 이 업로드의 사본은 지운다.
  const res = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO objects (owner_id, project_id, kind, hash, bytes, state, r2_key, refs, created_at, verified_at, etag) VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6, ?7, ?8, ?8, ?9) ON CONFLICT (owner_id, project_id, kind, hash) DO NOTHING").bind(u.owner_id, u.project_id, u.kind, u.hash, u.bytes, u.r2_key, refs, t, st.etag),
    c.env.DB.prepare("UPDATE uploads SET state = 'ready', verify_state = NULL, updated_at = ?1 WHERE upload_id = ?2 AND state = 'verifying'").bind(t, u.upload_id),
  ]);
  if (res[0].meta.changes === 0) await c.env.BUCKET.delete(u.r2_key);
  return json({ state: 'ready', kind: u.kind, hash: u.hash });
}

// ---------------- commit / CAS ----------------
interface RevisionIn { id: string; projectId: string; parentIds: string[]; snapshotHash: string; assetHashes: string[]; editSequence: number; createdAt: string }

function parseRevision(v: unknown, projectId: string): RevisionIn {
  const r = (v ?? {}) as Record<string, unknown>;
  const rev: RevisionIn = {
    id: needId(r.id, 'revision.id'), projectId: needId(r.projectId, 'revision.projectId'),
    parentIds: Array.isArray(r.parentIds) ? r.parentIds.map((x) => needId(x, 'parentIds[]')) : (() => { throw new ApiError(400, 'BAD_REQUEST', 'parentIds'); })(),
    snapshotHash: needHash(r.snapshotHash, 'snapshotHash'),
    assetHashes: Array.isArray(r.assetHashes) ? r.assetHashes.map((x) => needHash(x, 'assetHashes[]')) : (() => { throw new ApiError(400, 'BAD_REQUEST', 'assetHashes'); })(),
    editSequence: Number.isSafeInteger(r.editSequence) ? r.editSequence as number : (() => { throw new ApiError(400, 'BAD_REQUEST', 'editSequence'); })(),
    createdAt: typeof r.createdAt === 'string' && r.createdAt.length <= 40 ? r.createdAt : (() => { throw new ApiError(400, 'BAD_REQUEST', 'createdAt'); })(),
  };
  if (rev.projectId !== projectId) throw new ApiError(400, 'BAD_REQUEST', 'revision.projectId differs from the URL');
  if (rev.parentIds.length > 4 || rev.assetHashes.length > 10_000) throw new ApiError(400, 'BAD_REQUEST', 'too many parents/assets');
  return rev;
}

/** ready 객체만 참조할 수 있다. snapshot 이 실제로 참조하는 자산 집합과 revision.assetHashes 가 같아야 한다. */
async function checkRefs(c: Ctx, projectId: string, rev: RevisionIn) {
  const owner = c.session!.ownerId;
  const snap = await c.env.DB.prepare("SELECT refs FROM objects WHERE owner_id = ?1 AND project_id = ?2 AND kind = 'snapshot' AND hash = ?3 AND state = 'ready'").bind(owner, projectId, rev.snapshotHash).first<{ refs: string }>();
  const want = [...new Set(rev.assetHashes)].sort();
  const ready = new Set<string>();
  for (let i = 0; i < want.length; i += 90) { // D1: statement 당 bound parameter 100 개 한도
    const part = want.slice(i, i + 90);
    const rows = (await c.env.DB.prepare(`SELECT hash FROM objects WHERE owner_id = ?1 AND project_id = ?2 AND kind = 'asset' AND state = 'ready' AND hash IN (${part.map((_, k) => `?${k + 3}`).join(',')})`).bind(owner, projectId, ...part).all<{ hash: string }>()).results;
    rows.forEach((r) => ready.add(r.hash));
  }
  const missing = [...(snap ? [] : [`snapshot:${rev.snapshotHash}`]), ...want.filter((h) => !ready.has(h)).map((h) => `asset:${h}`)];
  if (missing.length) throw new ApiError(422, 'REF_NOT_READY', 'revision references objects that are not verified-ready', { missing });
  if (JSON.parse(snap!.refs) .join() !== want.join()) throw new ApiError(422, 'REVISION_MISMATCH', 'assetHashes differ from the assets referenced by the snapshot');
}

async function idempotent(c: Ctx, key: string, op: string, requestHash: string): Promise<{ status: string; [k: string]: unknown } | null> {
  const r = await c.env.DB.prepare('SELECT op, request_hash, response FROM idempotency WHERE owner_id = ?1 AND idem_key = ?2').bind(c.session!.ownerId, key).first<{ op: string; request_hash: string; response: string }>();
  if (!r) return null;
  if (r.op !== op || r.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', 'idempotency key reused with a different payload');
  return JSON.parse(r.response);
}

/** batch 실행. SQL 오류(transaction 실패)는 재시도 가능한 503 이며 논리적 CAS 실패(conflict)와 구분한다. */
async function runBatch(c: Ctx, stmts: ReturnType<Env['DB']['prepare']>[], key: string, op: string, requestHash: string): Promise<{ status: string; [k: string]: unknown }> {
  try {
    const res = await c.env.DB.batch(stmts);
    const row = res[res.length - 1].results[0] as { response: string } | undefined;
    if (!row) throw new Error('no idempotency row');
    return JSON.parse(row.response);
  } catch (e) {
    // 같은 key 의 동시 요청: 먼저 끝난 결과를 그대로 돌려준다(UNIQUE 위반으로 이쪽 batch 는 전체 rollback)
    const prior = await idempotent(c, key, op, requestHash).catch((x) => { throw x; });
    if (prior) return prior;
    throw new ApiError(503, 'DB_ERROR', `transaction failed (no state changed): ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

async function commit(req: Request, c: Ctx, projectId: string) {
  const b = await readJson<{ projectId?: unknown; revision?: unknown; expectedRemoteHead?: unknown; idempotencyKey?: unknown }>(req);
  if (b.projectId !== projectId) throw new ApiError(400, 'BAD_REQUEST', 'projectId differs from the URL');
  const key = needId(b.idempotencyKey, 'idempotencyKey');
  const expected = b.expectedRemoteHead === null ? null : needId(b.expectedRemoteHead, 'expectedRemoteHead');
  const rev = parseRevision(b.revision, projectId);
  const requestHash = await sha256(stable({ projectId, revision: rev, expectedRemoteHead: expected }));
  const prior = await idempotent(c, key, 'commit', requestHash);
  if (prior) return json(prior);
  await checkRefs(c, projectId, rev);
  const payloadHash = await sha256(stable(rev));
  const existing = await revisionRow(c, projectId, rev.id);
  if (existing && existing.payload_hash !== payloadHash) throw new ApiError(409, 'REVISION_EXISTS', 'a different revision with this id exists');
  await c.env.__beforeCas?.('commit');
  const owner = c.session!.ownerId; const t = iso(c.now());
  const DB = c.env.DB;
  const result = await runBatch(c, [
    DB.prepare('INSERT INTO owners (owner_id, created_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING').bind(owner, t),
    DB.prepare('INSERT INTO projects (owner_id, project_id, head, created_at, updated_at) SELECT ?1, ?2, NULL, ?3, ?3 WHERE ?4 IS NULL ON CONFLICT DO NOTHING').bind(owner, projectId, t, expected),
    DB.prepare("INSERT INTO revisions (owner_id, project_id, revision_id, kind, parent_ids, snapshot_hash, asset_hashes, edit_sequence, created_at, received_at, payload_hash) VALUES (?1, ?2, ?3, 'normal', ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT DO NOTHING")
      .bind(owner, projectId, rev.id, JSON.stringify(rev.parentIds), rev.snapshotHash, JSON.stringify([...new Set(rev.assetHashes)].sort()), rev.editSequence, rev.createdAt, t, payloadHash),
    // head CAS: affected row 가 1 일 때만 head 가 바뀐다. 실패해도 예외가 아니며 candidate 는 아래에서 branch 로 보존된다.
    DB.prepare('UPDATE projects SET head = ?1, head_seq = head_seq + 1, updated_at = ?2 WHERE owner_id = ?3 AND project_id = ?4 AND head IS ?5 AND tombstoned_at IS NULL').bind(rev.id, t, owner, projectId, expected),
    DB.prepare("INSERT INTO branches (owner_id, project_id, revision_id, reason, base_head, remote_head, pinned, created_at) SELECT ?1, ?2, ?3, 'conflict', ?4, p.head, 1, ?5 FROM (SELECT 1) LEFT JOIN projects p ON p.owner_id = ?1 AND p.project_id = ?2 WHERE p.head IS NOT ?3 ON CONFLICT DO NOTHING").bind(owner, projectId, rev.id, expected, t),
    DB.prepare(`INSERT INTO idempotency (owner_id, idem_key, op, project_id, request_hash, response, created_at)
      SELECT ?1, ?2, 'commit', ?3, ?4, CASE WHEN p.head IS ?5 THEN json_object('status', 'committed', 'remoteHead', ?5)
        ELSE json_object('status', 'conflict', 'remoteHead', p.head, 'retainedRevision', ?5, 'remoteDeleted', CASE WHEN p.tombstoned_at IS NULL THEN json('false') ELSE json('true') END) END, ?6
      FROM (SELECT 1) LEFT JOIN projects p ON p.owner_id = ?1 AND p.project_id = ?3`).bind(owner, key, projectId, requestHash, rev.id, t),
    DB.prepare('SELECT response FROM idempotency WHERE owner_id = ?1 AND idem_key = ?2').bind(owner, key),
  ], key, 'commit', requestHash);
  return json(result);
}

/** 충돌 local revision 을 head 를 건드리지 않고 보존 */
async function retainBranch(req: Request, c: Ctx, projectId: string) {
  const b = await readJson<{ revision?: unknown; idempotencyKey?: unknown }>(req);
  await ownedProject(c, projectId);
  const key = needId(b.idempotencyKey, 'idempotencyKey');
  const rev = parseRevision(b.revision, projectId);
  const requestHash = await sha256(stable({ projectId, revision: rev, op: 'branch' }));
  const prior = await idempotent(c, key, 'branch', requestHash);
  if (prior) return json(prior);
  await checkRefs(c, projectId, rev);
  const payloadHash = await sha256(stable(rev));
  const existing = await revisionRow(c, projectId, rev.id);
  if (existing && existing.payload_hash !== payloadHash) throw new ApiError(409, 'REVISION_EXISTS', 'a different revision with this id exists');
  const owner = c.session!.ownerId; const t = iso(c.now()); const DB = c.env.DB;
  return json(await runBatch(c, [
    DB.prepare("INSERT INTO revisions (owner_id, project_id, revision_id, kind, parent_ids, snapshot_hash, asset_hashes, edit_sequence, created_at, received_at, payload_hash) VALUES (?1, ?2, ?3, 'normal', ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT DO NOTHING")
      .bind(owner, projectId, rev.id, JSON.stringify(rev.parentIds), rev.snapshotHash, JSON.stringify([...new Set(rev.assetHashes)].sort()), rev.editSequence, rev.createdAt, t, payloadHash),
    DB.prepare("INSERT INTO branches (owner_id, project_id, revision_id, reason, base_head, remote_head, pinned, created_at) SELECT ?1, ?2, ?3, 'retained', NULL, p.head, 1, ?4 FROM projects p WHERE p.owner_id = ?1 AND p.project_id = ?2 ON CONFLICT DO NOTHING").bind(owner, projectId, rev.id, t),
    DB.prepare("INSERT INTO idempotency (owner_id, idem_key, op, project_id, request_hash, response, created_at) VALUES (?1, ?2, 'branch', ?3, ?4, json_object('status', 'retained', 'revisionId', ?5), ?6)").bind(owner, key, projectId, requestHash, rev.id, t),
    DB.prepare('SELECT response FROM idempotency WHERE owner_id = ?1 AND idem_key = ?2').bind(owner, key),
  ], key, 'branch', requestHash));
}

/** DELETE: expected head 위에 tombstone revision 을 CAS 로 올린다. 즉시 물리 삭제 금지. stale 이면 409. */
async function deleteProject(req: Request, c: Ctx, projectId: string) {
  const b = await readJson<{ expectedRemoteHead?: unknown; idempotencyKey?: unknown }>(req);
  await ownedProject(c, projectId);
  const key = needId(b.idempotencyKey, 'idempotencyKey');
  const expected = needId(b.expectedRemoteHead, 'expectedRemoteHead');
  const requestHash = await sha256(stable({ projectId, expected, op: 'delete' }));
  const prior = await idempotent(c, key, 'delete', requestHash);
  if (prior) return json(prior, prior.status === 'conflict' ? 409 : 200);
  await c.env.__beforeCas?.('delete');
  const owner = c.session!.ownerId; const now = c.now(); const t = iso(now); const purge = iso(now + c.cfg.tombstoneMs); const DB = c.env.DB;
  const tid = `t_${(await sha256(`${owner}|${key}`)).slice(0, 32)}`;
  const r = await runBatch(c, [
    DB.prepare(`INSERT INTO revisions (owner_id, project_id, revision_id, kind, parent_ids, snapshot_hash, asset_hashes, edit_sequence, created_at, received_at, payload_hash)
      SELECT ?1, ?2, ?3, 'tombstone', json_array(?4), r.snapshot_hash, r.asset_hashes, r.edit_sequence, ?5, ?5, ?6
      FROM projects p JOIN revisions r ON r.owner_id = p.owner_id AND r.project_id = p.project_id AND r.revision_id = p.head
      WHERE p.owner_id = ?1 AND p.project_id = ?2 AND p.head IS ?4 AND p.tombstoned_at IS NULL ON CONFLICT DO NOTHING`).bind(owner, projectId, tid, expected, t, requestHash),
    DB.prepare('UPDATE projects SET head = ?1, head_seq = head_seq + 1, tombstoned_at = ?2, purge_after = ?3, updated_at = ?2 WHERE owner_id = ?4 AND project_id = ?5 AND head IS ?6 AND tombstoned_at IS NULL').bind(tid, t, purge, owner, projectId, expected),
    DB.prepare('INSERT INTO tombstones (owner_id, project_id, revision_id, deleted_at, purge_after) SELECT ?1, ?2, ?3, ?4, ?5 FROM projects p WHERE p.owner_id = ?1 AND p.project_id = ?2 AND p.head = ?3 ON CONFLICT DO NOTHING').bind(owner, projectId, tid, t, purge),
    DB.prepare(`INSERT INTO idempotency (owner_id, idem_key, op, project_id, request_hash, response, created_at)
      SELECT ?1, ?2, 'delete', ?3, ?4, CASE WHEN p.head = ?5 THEN json_object('status', 'deleted', 'remoteHead', ?5, 'purgeAfter', p.purge_after) ELSE json_object('status', 'conflict', 'remoteHead', p.head) END, ?6
      FROM projects p WHERE p.owner_id = ?1 AND p.project_id = ?3`).bind(owner, key, projectId, requestHash, tid, t),
    DB.prepare('SELECT response FROM idempotency WHERE owner_id = ?1 AND idem_key = ?2').bind(owner, key),
  ], key, 'delete', requestHash);
  return json(r, r.status === 'conflict' ? 409 : 200);
}

/** tombstone 또는 보존 revision(충돌 branch 포함) → 새 head. CAS 필요. */
async function restore(req: Request, c: Ctx, projectId: string) {
  const b = await readJson<{ expectedRemoteHead?: unknown; revisionId?: unknown; idempotencyKey?: unknown }>(req);
  await ownedProject(c, projectId);
  const key = needId(b.idempotencyKey, 'idempotencyKey');
  const expected = needId(b.expectedRemoteHead, 'expectedRemoteHead');
  const target = needId(b.revisionId, 'revisionId');
  const requestHash = await sha256(stable({ projectId, expected, target, op: 'restore' }));
  const prior = await idempotent(c, key, 'restore', requestHash);
  if (prior) return json(prior, prior.status === 'conflict' ? 409 : 200);
  const tr = await revisionRow(c, projectId, target);
  if (!tr) throw new ApiError(404, 'NOT_FOUND', 'revision not found');
  if (tr.kind === 'tombstone') throw new ApiError(400, 'BAD_REQUEST', 'cannot restore a tombstone; choose the revision before it');
  await c.env.__beforeCas?.('restore');
  const owner = c.session!.ownerId; const t = iso(c.now()); const DB = c.env.DB;
  const rid = `r_${(await sha256(`${owner}|${key}`)).slice(0, 32)}`;
  const r = await runBatch(c, [
    DB.prepare(`INSERT INTO revisions (owner_id, project_id, revision_id, kind, parent_ids, snapshot_hash, asset_hashes, edit_sequence, created_at, received_at, payload_hash)
      SELECT ?1, ?2, ?3, 'restore', json_array(?4, ?5), x.snapshot_hash, x.asset_hashes, x.edit_sequence, ?6, ?6, ?7
      FROM revisions x JOIN projects p ON p.owner_id = x.owner_id AND p.project_id = x.project_id
      WHERE x.owner_id = ?1 AND x.project_id = ?2 AND x.revision_id = ?5 AND p.head IS ?4 ON CONFLICT DO NOTHING`).bind(owner, projectId, rid, expected, target, t, requestHash),
    DB.prepare('UPDATE projects SET head = ?1, head_seq = head_seq + 1, tombstoned_at = NULL, purge_after = NULL, updated_at = ?2 WHERE owner_id = ?3 AND project_id = ?4 AND head IS ?5').bind(rid, t, owner, projectId, expected),
    DB.prepare('UPDATE tombstones SET restored_at = ?1 WHERE owner_id = ?2 AND project_id = ?3 AND revision_id = ?4 AND (SELECT head FROM projects WHERE owner_id = ?2 AND project_id = ?3) = ?5').bind(t, owner, projectId, expected, rid),
    DB.prepare(`INSERT INTO idempotency (owner_id, idem_key, op, project_id, request_hash, response, created_at)
      SELECT ?1, ?2, 'restore', ?3, ?4, CASE WHEN p.head = ?5 THEN json_object('status', 'committed', 'remoteHead', ?5, 'restoredFrom', ?6) ELSE json_object('status', 'conflict', 'remoteHead', p.head) END, ?7
      FROM projects p WHERE p.owner_id = ?1 AND p.project_id = ?3`).bind(owner, key, projectId, requestHash, rid, target, t),
    DB.prepare('SELECT response FROM idempotency WHERE owner_id = ?1 AND idem_key = ?2').bind(owner, key),
  ], key, 'restore', requestHash);
  return json(r, r.status === 'conflict' ? 409 : 200);
}

// ---------------- GC ----------------
/**
 * 정지 상태 정리(scheduled). reachability: 모든 revision(normal/tombstone/restore/branch)이 참조하는 객체는 유지.
 * 지우는 것: 만료된 미완료 업로드(multipart abort·미검증 객체), 7일 넘게 어떤 revision 도 참조하지 않은 orphan 객체, 오래된 rate 창.
 * tombstone 보존 기한이 지난 project 는 개수만 보고한다(MVP-7 은 사용자 데이터 물리 삭제를 하지 않는다).
 */
export async function gc(env: Env, now: number) {
  const expired = (await env.DB.prepare("SELECT * FROM uploads WHERE state IN ('pending', 'verifying') AND expires_at < ?1 LIMIT 500").bind(now).all<UploadRow>()).results;
  for (const u of expired) await abortUpload(env, u, 'expired');
  const cutoff = iso(now - 7 * 86_400_000);
  const orphans = (await env.DB.prepare(`SELECT o.owner_id, o.project_id, o.kind, o.hash, o.r2_key FROM objects o
    WHERE o.state = 'ready' AND o.created_at < ?1
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.owner_id = o.owner_id AND r.project_id = o.project_id AND (r.snapshot_hash = o.hash OR EXISTS (SELECT 1 FROM json_each(r.asset_hashes) j WHERE j.value = o.hash)))
      AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.owner_id = o.owner_id AND u.project_id = o.project_id AND u.hash = o.hash AND u.state IN ('pending', 'verifying'))
    LIMIT 500`).bind(cutoff).all<{ owner_id: string; project_id: string; kind: string; hash: string; r2_key: string }>()).results;
  for (const o of orphans) {
    await env.BUCKET.delete(o.r2_key);
    await env.DB.prepare('DELETE FROM objects WHERE owner_id = ?1 AND project_id = ?2 AND kind = ?3 AND hash = ?4').bind(o.owner_id, o.project_id, o.kind, o.hash).run();
  }
  // D1 에 기록되지 않은 R2 객체(complete 후 D1 갱신 전 crash 등) 중 7일 지난 것
  const stray: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const l = await env.BUCKET.list({ prefix: 'o/', cursor, limit: 500 });
    for (const o of l.objects) {
      if (o.uploaded.getTime() > now - 7 * 86_400_000) continue;
      const known = await env.DB.prepare("SELECT 1 AS x FROM objects WHERE r2_key = ?1 UNION ALL SELECT 1 FROM uploads WHERE r2_key = ?1 AND state IN ('pending', 'verifying')").bind(o.key).first();
      if (!known) { stray.push(o.key); await env.BUCKET.delete(o.key); }
    }
    if (!l.truncated) break; cursor = l.cursor;
  }
  await env.DB.prepare('DELETE FROM rate WHERE window < ?1').bind(Math.floor(now / 60_000) - 60).run();
  const purge = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE tombstoned_at IS NOT NULL AND purge_after < ?1').bind(iso(now)).first<{ n: number }>();
  return { strayObjects: stray.length, expiredUploads: expired.length, orphanObjects: orphans.map((o) => `${o.kind}:${o.hash}`), purgeEligibleTombstones: purge?.n ?? 0, purged: 0 };
}

export { ApiError };
