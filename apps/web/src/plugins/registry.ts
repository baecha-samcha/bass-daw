import reviewed from './reviewed.json';
// 설치된 플러그인 영속화: 메타는 IDB 'meta' store, 번들 바이트는 ByteStore plugins/<key>-<hash>.
import { req, txDone, type LocalStore } from '@bass-daw/storage';
import { PluginHost, reviewedList, type ReviewPolicy, type InstalledPlugin, type PluginRegistryStore, type InspectedPlugin, type ConformanceReport } from '@bass-daw/plugin-api';

export function registryStore(store: LocalStore): PluginRegistryStore {
  const path = (r: InstalledPlugin) => `plugins/${r.key}-${r.bundleHash}`;
  return {
    async list() {
      const all = await req(store.db.transaction('meta').objectStore('meta').getAll()) as { key: string; record?: InstalledPlugin }[];
      return all.filter((x) => x.key.startsWith('plugin:') && x.record).map((x) => x.record!);
    },
    async get(key) {
      const m = await req(store.db.transaction('meta').objectStore('meta').get(`plugin:${key}`)) as { record: InstalledPlugin } | undefined;
      if (!m) return null;
      const blob = await store.bytes.read(path(m.record));
      return blob ? { record: m.record, bundle: new Uint8Array(await blob.arrayBuffer()) } : null;
    },
    async put(record, bundle) {
      await store.bytes.write(path(record), bundle);
      const tx = store.db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: `plugin:${record.key}`, record }); await txDone(tx);
    },
    async remove(key) {
      const got = await this.get(key);
      const tx = store.db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete(`plugin:${key}`); await txDone(tx);
      if (got) await store.bytes.remove(path(got.record));
    },
  };
}

/** 설치 전 시험 렌더: 별도 Worker + 5초 watchdog. 무한 루프는 terminate 로만 끝난다(실시간 격리 보장 아님). */
export function workerTestRunner(timeoutMs = 5000) {
  return (p: InspectedPlugin) => new Promise<{ ok: boolean; report: unknown; reason?: string }>((resolve) => {
    const w = new Worker(new URL('../workers/plugin-test.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, report: null, reason: `WATCHDOG: test render did not finish in ${timeoutMs / 1000}s (worker terminated)` }); }, timeoutMs);
    w.onmessage = (e) => {
      clearTimeout(timer); w.terminate();
      const r = e.data as { report?: ConformanceReport; error?: string };
      if (r.error) return resolve({ ok: false, report: null, reason: r.error });
      const failed = r.report!.checks.filter((c) => !c.ok);
      resolve({ ok: r.report!.ok, report: r.report, reason: failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ') });
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ ok: false, report: null, reason: e.message }); };
    w.postMessage({ dsp: p.dsp, manifest: p.manifest, memoryPages: p.memoryPages });
  });
}

/**
 * 검토된 고정 hash 목록(D05). 저장소 리뷰를 거친 plugins/ 번들만 빌드 시점에 앱에 박힌다(런타임 fetch·사용자 추가 없음).
 * e2e 빌드(--mode e2e)에서만 테스트 번들 hash 를 추가할 수 있다 — production 빌드는 이 값을 무시한다.
 */
export function reviewPolicy(): ReviewPolicy {
  const extra = import.meta.env.MODE === 'e2e' ? String(import.meta.env.VITE_E2E_REVIEWED ?? '').split(',').filter(Boolean).map((e) => { const [id, rest] = e.split('@'); const [version, bundleSha256] = rest.split('#'); return { pluginId: id, version, bundleSha256 }; }) : [];
  return reviewedList([...reviewed, ...extra]);
}

export function createPluginHost(store: LocalStore): PluginHost { return new PluginHost(registryStore(store), workerTestRunner(), reviewPolicy()); }

export const pinKey = (pluginId: string, version: string) => `pluginHash:${pluginId}@${version}`;
