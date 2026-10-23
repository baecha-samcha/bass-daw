// 계약 스위트 — Node 대체 환경(node:sqlite D1 + 로컬 R2). 실제 workerd/Cloudflare 결과가 아니다.
import { describe } from 'vitest';
import { handle } from '../src/app.ts';
import { localEnv } from '../local/env.ts';
import { contractSuite } from './contract.ts';

describe('contract [Node substitute: node:sqlite D1 + local R2]', () => {
  contractSuite(async (vars) => {
    const env = localEnv({ vars: { CHUNK_BYTES: '65536', ...vars } });
    return {
      base: 'http://localhost',
      fetch: (url, init) => handle(new Request(url, init), env),
      keys: async () => env.BUCKET.keys(),
      overwrite: async (k, b) => { await env.BUCKET.put(k, b); },
      close: async () => env.DB.close(),
    };
  });
});
