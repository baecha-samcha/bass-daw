// 테스트·진단용 읽기 전용 훅. 사용자 음악 데이터를 외부로 보내지 않는다.
import { compilePlan } from '@bass-daw/audio-engine';
import { snapshotHash, sha256HexSync } from '@bass-daw/schemas';
import { useApp } from './store.ts';
import { engine } from './audio/engine.ts';
import { workerHasher } from './sync/hasher.ts';
import { streamHasher } from '@bass-daw/storage';

export function installDebugHooks() {
  (globalThis as unknown as { __bassdaw: unknown }).__bassdaw = {
    state: () => useApp.getState(),
    engine,
    hasher: workerHasher,
    mainThreadHash: streamHasher,
    projectHash: () => { const p = useApp.getState().project; return p ? snapshotHash(p) : null; },
    /** 4악기 재생 이벤트 서명: 48k 에서 컴파일한 이벤트 표의 hash (자산 없이도 이벤트는 동일) */
    planHash: () => {
      const p = useApp.getState().project; if (!p) return null;
      const r = compilePlan(p, { sampleRate: 48000, assetInfo: () => ({ sampleRate: 48000, channels: 1 }) });
      if (!r.ok) return r.code;
      const e = r.events; const parts: string[] = [];
      for (let i = 0; i < e.count; i++) parts.push(`${e.frame[i]}:${e.kind[i]}:${e.track[i]}:${e.a[i]}:${e.b[i]}:${e.channel[i]}`);
      return { count: e.count, hash: sha256HexSync(new TextEncoder().encode(parts.join('\n'))) };
    },
  };
}
