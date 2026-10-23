// esbuild 번들: dist/worker.js(배포용 Worker 산출물, 배포는 하지 않음) + dist/local-server.mjs(Node 로컬 서버)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const alias = { '@bass-daw/schemas': fileURLToPath(new URL('../../../packages/schemas/src/index.ts', import.meta.url)) };
await build({ entryPoints: [`${root}src/index.ts`], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: `${root}dist/worker.js`, alias, logLevel: 'warning' });
await build({ entryPoints: [`${root}local/server.ts`], bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: `${root}dist/local-server.mjs`, alias, logLevel: 'warning', external: ['node:*'] });
console.log('built apps/api/dist/{worker.js,local-server.mjs}');
