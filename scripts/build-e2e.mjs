// e2e 전용 빌드: 샘플 플러그인 + 테스트 번들(tests/fixtures/e2e-plugins) → vite build --mode e2e.
// 테스트 번들 hash 는 VITE_E2E_REVIEWED 로만 주입되며 앱은 MODE==='e2e' 일 때만 읽는다(production 빌드는 무시).
// 이 산출물은 배포하지 않는다 — 배포 후보는 항상 `pnpm build`(production) 로 다시 만든다.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
run('node', ['scripts/build-plugins.mjs']);
run('node', ['scripts/build-plugins.mjs', '--src', 'tests/fixtures/e2e-plugins', '--out', 'tests/artifacts/e2e-plugins', '--no-reviewed']);
const extra = JSON.parse(readFileSync('tests/artifacts/e2e-plugins/index.json', 'utf8')).map((x) => `${x.pluginId}@${x.version}#${x.bundleSha256}`).join(',');
run('pnpm', ['--filter', '@bass-daw/web', 'exec', 'vite', 'build', '--mode', 'e2e'], { VITE_E2E_REVIEWED: extra });
