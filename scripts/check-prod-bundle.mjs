// production 빌드 산출물 검사: fake auth·e2e 검토 hash·로컬 API 주소가 들어가지 않았는지 확인한다.
// 사용: pnpm build && node scripts/check-prod-bundle.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dist = 'apps/web/dist';
const files = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)); }; walk(dist);
const forbidden = ['/v1/dev/login', '개발용 로그인', 'localhost:8787', 'com.example.evilui', '/v1/projects', '/v1/chunks', '/v1/blobs', '클라우드 연결'];
if (existsSync('tests/artifacts/e2e-plugins/index.json')) for (const x of JSON.parse(readFileSync('tests/artifacts/e2e-plugins/index.json', 'utf8'))) forbidden.push(x.bundleSha256);
const hits = [];
for (const f of files.filter((x) => /\.(js|html|json)$/.test(x))) { const t = readFileSync(f, 'utf8'); for (const s of forbidden) if (t.includes(s)) hits.push(`${f}: ${s.slice(0, 24)}`); }
const reviewed = JSON.parse(readFileSync('apps/web/src/plugins/reviewed.json', 'utf8'));
const js = files.filter((x) => x.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
for (const r of reviewed) if (!js.includes(r.bundleSha256)) hits.push(`missing reviewed hash ${r.pluginId}`);
if (hits.length) { console.error('production bundle check FAILED:\n' + hits.join('\n')); process.exit(1); }
console.log(`production bundle check OK (${files.length} files; no fake auth / e2e hashes / local API; ${reviewed.length} reviewed hashes embedded)`);
