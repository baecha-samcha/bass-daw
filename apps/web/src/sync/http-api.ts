// RemoteApi 의 fetch 구현(앱 계층). 세션 토큰은 Authorization 헤더로만 보낸다. 네트워크 오류는 status 0 / NETWORK.
import type { ApiResult, RemoteApi } from '@bass-daw/storage';

export function httpRemoteApi(base: string, token: () => string | null, fetchImpl: typeof fetch = (...a) => fetch(...a)): RemoteApi {
  async function call<T>(method: string, url: string, body?: unknown, raw?: Uint8Array): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    const t = token(); if (t) headers.authorization = `Bearer ${t}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let r: Response;
    try {
      r = await fetchImpl(url.startsWith('http') ? url : `${base}${url}`, { method, headers, body: raw ? (raw as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (e) { return { ok: false, status: 0, code: 'NETWORK', message: String((e as Error)?.message ?? e) }; }
    if (r.ok && r.headers.get('content-type')?.includes('application/octet-stream')) return { ok: true, status: r.status, value: new Uint8Array(await r.arrayBuffer()) as T };
    let data: Record<string, unknown> = {};
    try { data = await r.json(); } catch { if (!r.ok) return { ok: false, status: r.status, code: r.status >= 500 ? 'NETWORK' : 'HTTP_ERROR', message: `HTTP ${r.status}` }; }
    // DELETE/restore 의 409 conflict 는 정의된 결과(body.status) — 값으로 돌려준다
    if (r.ok || (r.status === 409 && data.status === 'conflict')) return { ok: true, status: r.status, value: data as T };
    const ra = Number(r.headers.get('retry-after'));
    return { ok: false, status: r.status, code: String(data.error ?? 'HTTP_ERROR'), message: String(data.message ?? `HTTP ${r.status}`), retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, body: data };
  }
  const P = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;
  return {
    config: () => call('GET', '/v1/config'),
    listProjects: (cursor) => call('GET', `/v1/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    head: (id) => call('GET', `${P(id)}/head`),
    createUpload: (id, body) => call('POST', `${P(id)}/uploads`, body),
    uploadStatus: (id, u) => call('GET', `${P(id)}/uploads/${u}`),
    putChunk: (url, bytes) => call('PUT', url, undefined, bytes),
    completeUpload: (id, u) => call('POST', `${P(id)}/uploads/${u}/complete`, {}),
    commit: (id, req) => call('POST', `${P(id)}/commits`, req),
    retainBranch: (id, body) => call('POST', `${P(id)}/branches`, body),
    revision: (id, rev) => call('GET', `${P(id)}/revisions/${rev}`),
    download: (url) => call('GET', url),
    deleteProject: (id, body) => call('DELETE', P(id), body),
    restore: (id, body) => call('POST', `${P(id)}/restore`, body),
  };
}
