// 로컬 개발 API 서버: Node http → Web Request → Worker handle(). `pnpm --filter @bass-daw/api dev`
//   --port 8787 --state <dir>(영속, 생략 시 메모리) --reset(state 삭제 후 시작)
// 실제 Cloudflare 계정·리소스를 쓰지 않는다. fake auth 는 development + localhost 에서만 동작한다.
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { handle } from '../src/app.ts';
import { localEnv } from './env.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('--port', '8787'));
const dir = arg('--state') ?? null;
if (dir && process.argv.includes('--reset')) rmSync(dir, { recursive: true, force: true });
const env = localEnv({ dir, vars: { CHUNK_BYTES: process.env.CHUNK_BYTES, URL_TTL_SEC: process.env.URL_TTL_SEC, VERIFY_BUDGET_BYTES: process.env.VERIFY_BUDGET_BYTES } });

createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const r = await handle(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: hasBody ? Readable.toWeb(req) as ReadableStream : undefined, duplex: 'half' } as RequestInit), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) Readable.fromWeb(r.body as never).pipe(res); else res.end();
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(port, '127.0.0.1', () => console.log(`bass-daw api (local D1/R2, fake auth dev-only) on http://localhost:${port} state=${dir ?? 'memory'}`));
