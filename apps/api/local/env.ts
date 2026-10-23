// 로컬 Workers 환경 조립: LocalD1(node:sqlite) + LocalR2 + 개발용 vars. 비밀값은 실행마다 무작위 생성(파일·Git 에 기록하지 않음).
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { Env } from '../src/env.ts';
import { LocalD1 } from './d1.ts';
import { LocalR2 } from './r2.ts';

export const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

export function localEnv(opts: { dir?: string | null; vars?: Partial<Env> } = {}): Env & { DB: LocalD1; BUCKET: LocalR2 } {
  if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  const DB = new LocalD1(opts.dir ? `${opts.dir}/d1.sqlite` : ':memory:');
  DB.migrate(MIGRATIONS);
  const BUCKET = new LocalR2(opts.dir ? `${opts.dir}/r2` : null);
  if (opts.vars?.__now) BUCKET.now = opts.vars.__now;
  return {
    AUTH_MODE: 'fake', ENVIRONMENT: 'development',
    FAKE_AUTH_SECRET: randomBytes(24).toString('hex'), SIGNING_SECRET: randomBytes(24).toString('hex'),
    ALLOWED_ORIGINS: 'http://localhost:4173,http://localhost:5173,http://127.0.0.1:4173,http://127.0.0.1:5173',
    ...opts.vars,
    DB, BUCKET,
  };
}
