// plugins/<name>/{manifest.json,dsp.wat,ui.html?} → apps/web/public/plugins/<name>.bdplugin
// manifest 의 dsp/ui sha256 을 채우고 결정적 ZIP(고정 mtime)을 만든다. 번들 SHA-256 을 출력(설치 승인 hash).
// 검토 목록(reviewed.json): 저장소 리뷰를 거친 plugins/ 번들의 고정 hash. 앱은 이 목록에 없는 번들을 설치·실행하지 않는다.
//   --src <dir> --out <dir> [--reviewed <file>|--no-reviewed]
//   파일 X 가 없고 X.ref 가 있으면 ref 에 적힌 저장소 상대 경로를 읽는다(테스트 번들이 샘플 WAT 를 재사용).
import wabtInit from 'wabt';
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const srcDir = arg('--src', 'plugins');
const outDir = arg('--out', 'apps/web/public/plugins');
const reviewedOut = process.argv.includes('--no-reviewed') ? null : arg('--reviewed', 'apps/web/src/plugins/reviewed.json');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const readSrc = (p, enc) => existsSync(p) ? readFileSync(p, enc) : readFileSync(readFileSync(`${p}.ref`, 'utf8').trim(), enc);
const wabt = await wabtInit();
mkdirSync(outDir, { recursive: true });
const index = [];
for (const name of readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const dir = `${srcDir}/${name}`;
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const mod = wabt.parseWat(`${dir}/dsp.wat`, readSrc(`${dir}/dsp.wat`, 'utf8'));
  const dsp = new Uint8Array(mod.toBinary({}).buffer);
  manifest.dsp.sha256 = sha(dsp);
  const files = {};
  const mtime = new Date(Date.UTC(2026, 9, 22));
  if (manifest.ui) {
    const ui = readSrc(`${dir}/${manifest.ui.path}`);
    manifest.ui.sha256 = sha(ui);
    files[manifest.ui.path] = [new Uint8Array(ui), { level: 6, mtime }];
  }
  files[manifest.dsp.path] = [dsp, { level: 6, mtime }];
  const bundle = zipSync({ 'manifest.json': [strToU8(JSON.stringify(manifest, null, 2)), { level: 6, mtime }], ...files });
  writeFileSync(`${outDir}/${name}.bdplugin`, bundle);
  index.push({ file: `${name}.bdplugin`, pluginId: manifest.pluginId, version: manifest.version, role: manifest.role, name: manifest.name, bundleSha256: sha(bundle) });
  console.log(`${name}: ${manifest.pluginId}@${manifest.version} bundle sha256 ${sha(bundle)} (${bundle.length} B)`);
}
writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 2));
if (reviewedOut) {
  const reviewed = index.map((x) => ({ pluginId: x.pluginId, version: x.version, bundleSha256: x.bundleSha256, source: `${srcDir}/${x.file.replace(/\.bdplugin$/, '')}` }));
  writeFileSync(reviewedOut, JSON.stringify(reviewed, null, 2) + '\n');
  console.log(`reviewed list → ${reviewedOut} (${reviewed.length})`);
}
