import { defineConfig } from '@playwright/test';

// Pi 개발 환경: 시스템 Chromium 사용, worker 1개.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'tests/artifacts/e2e-results.json' }]],
  use: {
    baseURL: 'http://localhost:4173/',
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'node scripts/build-e2e.mjs && pnpm --filter @bass-daw/web exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173/',
      reuseExistingServer: true,
      timeout: 180_000,
    },

  ],
});
