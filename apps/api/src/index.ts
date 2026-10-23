// Cloudflare Workers 진입점(배포 시 wrangler 가 번들). 로컬 개발·테스트는 local/ 의 Node D1/R2 어댑터로 같은 handle 을 실행한다.
import { handle, gc } from './app.ts';
import type { Env } from './env.ts';

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) { ctx.waitUntil(gc(env, Date.now())); },
};
