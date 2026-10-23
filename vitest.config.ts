import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkgs = ['schemas', 'music-core', 'tab-engine', 'midi-engine', 'project-core', 'storage', 'audio-engine', 'ui', 'plugin-api', 'notation'];
const alias = pkgs.map((p) => ({ find: new RegExp(`^@bass-daw/${p}$`), replacement: fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)) }));

// Pi 메모리를 고려해 worker 수를 제한한다.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/perf/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 2,
    testTimeout: 120_000,
  },
});
