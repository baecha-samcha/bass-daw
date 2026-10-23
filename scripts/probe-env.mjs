// MVP-0: 개발 환경 조사 (root 권한/전역 설치 없이). 결과를 docs/reports/env-probe.json 에 기록.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const r = {
  at: new Date().toISOString(),
  node: process.version, pnpm: sh('pnpm -v'), corepack: sh('corepack --version'),
  os: `${os.type()} ${os.release()}`, distro: sh('. /etc/os-release && echo "$PRETTY_NAME"'), arch: os.arch(), cpus: os.cpus().length, cpuModel: sh("grep -m1 'Model' /proc/cpuinfo | cut -d: -f2") ?? os.cpus()[0]?.model,
  memTotalGiB: +(os.totalmem() / 2 ** 30).toFixed(2), memFreeGiB: +(os.freemem() / 2 ** 30).toFixed(2), memAvailable: sh("grep MemAvailable /proc/meminfo"),
  disk: sh('df -h . | tail -1'), chromium: sh('chromium --version'), git: sh('git --version'), gitStatus: sh('git status --short | wc -l'), gitHead: sh('git rev-parse --short HEAD'),
  root: process.getuid?.() === 0,
};
mkdirSync('docs/reports', { recursive: true });
writeFileSync('docs/reports/env-probe.json', JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2));
