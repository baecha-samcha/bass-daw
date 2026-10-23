import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// SharedArrayBuffer 를 위한 cross-origin isolation (01 §5). 모든 자산은 same-origin.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** 빌드 산출물 목록을 서비스워커에 주입해 hash 버전 앱 shell 을 캐시한다(04 §4 PWA). */
function swManifest(): Plugin {
  return {
    name: 'bass-daw-sw-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      // 악보 폰트(Bravura)도 shell 에 포함 → 오프라인 인쇄
      const list = ['./', './index.html', './manifest.webmanifest', './icon.svg', './alphatab/font/Bravura.woff2', './alphatab/font/Bravura.woff', ...files.map((f) => `./${f}`)];
      const h = createHash('sha256');
      for (const b of Object.values(bundle)) h.update('code' in b ? b.code : (b as { source: string | Uint8Array }).source);
      const version = h.digest('hex').slice(0, 16);
      const tpl = readFileSync(fileURLToPath(new URL('./sw-template.js', import.meta.url)), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: tpl.replace('__SHELL_FILES__', JSON.stringify(list)).replace('__SHELL_VERSION__', version) });
    },
  };
}

const pkgs = ['schemas', 'music-core', 'tab-engine', 'midi-engine', 'project-core', 'storage', 'audio-engine', 'ui', 'plugin-api', 'notation'];

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), swManifest(), ...(mode === 'https' ? [basicSsl()] : [])],
  resolve: { alias: pkgs.map((p) => ({ find: new RegExp(`^@bass-daw/${p}$`), replacement: fileURLToPath(new URL(`../../packages/${p}/src/index.ts`, import.meta.url)) })) },
  server: { headers: isolation, port: 5173, host: true },
  preview: { headers: isolation, port: 4173, host: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
}));
