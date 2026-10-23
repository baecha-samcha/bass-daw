// 계약 스위트 — 실제 workerd 런타임(Miniflare 4)에서 번들 Worker(dist/worker.js) + Miniflare D1/R2 시뮬레이터.
// 이 Pi(커널 39-bit VA)에서는 workerd 가 시작되지 않는다 → skip(보고서 NOT-RUN). x86_64 CI 에서 REQUIRE_WORKERD=1 로 실행하면
// workerd 가 없을 때 skip 대신 실패한다. 실제 Cloudflare 서비스(배포된 Worker/D1/R2) 결과가 아니다.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { contractSuite } from './contract.ts';

const require = createRequire(import.meta.url);
const mfPath = (() => { try { return require.resolve('miniflare', { paths: ['apps/api'] }); } catch { return null; } })();
function workerdUsable(): boolean {
  try {
    const bin = require.resolve('workerd/bin/workerd', { paths: [mfPath!] });
    return spawnSync(process.execPath, [bin, '--version'], { timeout: 20_000 }).status === 0;
  } catch { return false; }
}
const usable = !!mfPath && workerdUsable();
const required = process.env.REQUIRE_WORKERD === '1';

describe.skipIf(!usable)('contract [real workerd runtime via Miniflare]', () => {
  beforeAll(() => { execFileSync(process.execPath, ['apps/api/scripts/build.mjs']); });
  const migrations = readdirSync('apps/api/migrations').sort().flatMap((f) => readFileSync(`apps/api/migrations/${f}`, 'utf8').replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean));
  contractSuite(async (vars) => {
    const { Miniflare } = await import(mfPath!);
    const mf = new Miniflare({
      modules: true, scriptPath: 'apps/api/dist/worker.js', compatibilityDate: '2026-07-01',
      d1Databases: ['DB'], r2Buckets: ['BUCKET'],
      bindings: { AUTH_MODE: 'fake', ENVIRONMENT: 'development', FAKE_AUTH_SECRET: randomBytes(24).toString('hex'), SIGNING_SECRET: randomBytes(24).toString('hex'), CHUNK_BYTES: '65536', ALLOWED_ORIGINS: 'http://localhost:4173', ...vars },
    });
    const db = await mf.getD1Database('DB');
    for (const stmt of migrations) await db.prepare(stmt).run();
    const bucket = await mf.getR2Bucket('BUCKET');
    return {
      base: 'http://localhost',
      fetch: async (url: string, init?: RequestInit) => { const r = await mf.dispatchFetch(url, init as never); return new Response(await r.arrayBuffer(), { status: r.status, headers: Object.fromEntries(r.headers) }); },
      keys: async () => { const out: string[] = []; let cursor: string | undefined; do { const l = await bucket.list({ prefix: 'o/', cursor }); out.push(...l.objects.map((o: { key: string }) => o.key)); cursor = l.truncated ? l.cursor : undefined; } while (cursor); return out; },
      overwrite: async (k: string, b: Uint8Array) => { await bucket.put(k, b); },
      close: () => mf.dispose(),
    };
  });
});

describe.skipIf(usable)('workerd availability on this host', () => {
  it('records why the workerd contract suite is not run here (fails when REQUIRE_WORKERD=1)', () => {
    const va = (() => { try { return readFileSync(`/boot/config-${execFileSync('uname', ['-r']).toString().trim()}`, 'utf8').match(/CONFIG_ARM64_VA_BITS=(\d+)/)?.[1] ?? '?'; } catch { return '?'; } })();
    console.log(`[NOT-RUN] workerd/Miniflare unavailable on this host (arch ${process.arch}, ARM64 VA bits ${va}); only the Node substitute suite ran`);
    expect(required, 'REQUIRE_WORKERD=1 but workerd is not runnable').toBe(false);
  });
});
