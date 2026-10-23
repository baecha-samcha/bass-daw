// 로컬 D1 어댑터: node:sqlite(SQLite 3.5x) 로 Worker 가 쓰는 D1 부분 집합을 구현한다.
// 이 Pi(커널 39-bit VA)에서는 workerd/Miniflare 가 실행되지 않아(tcmalloc 48-bit 가정) 대신 사용한다 — docs/decisions/0010.
// 의미 보존: batch = 단일 transaction(실패 시 전체 rollback 후 throw), run().meta.changes = affected rows, ?NNN 바인딩,
// bound parameter 100개 한도(D1 과 동일하게 초과 시 오류).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/env.ts';

const MAX_PARAMS = 100;
type Value = null | number | bigint | string | Uint8Array;

class Stmt implements D1PreparedStatement {
  constructor(private db: LocalD1, readonly sql: string, readonly params: Value[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement {
    if (values.length > MAX_PARAMS) throw new Error(`D1_ERROR: too many SQL variables (${values.length} > ${MAX_PARAMS})`);
    return new Stmt(this.db, this.sql, values.map((v) => {
      if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a supported bind value');
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as Value;
    }));
  }
  private prep(): StatementSync { return this.db.raw.prepare(this.sql); }
  exec(): D1Result {
    const st = this.prep();
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
      const rows = st.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map(plain), success: true, meta: { changes: /\breturning\b/i.test(this.sql) ? rows.length : 0, last_row_id: 0 } };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(): Promise<T | null> { await this.db.tick(); return (this.exec().results[0] as T) ?? null; }
  async all<T>(): Promise<D1Result<T>> { await this.db.tick(); return this.exec() as D1Result<T>; }
  async run(): Promise<D1Result> { await this.db.tick(); return this.exec(); }
}

const plain = (r: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v; return o; };

export class LocalD1 implements D1Database {
  readonly raw: DatabaseSync;
  /** 장애 주입: batch 직전에 호출(throw 하면 SQL transaction 실패를 흉내) */
  failNextBatch: Error | null = null;
  constructor(path = ':memory:') { this.raw = new DatabaseSync(path); this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'); }
  /** 실제 D1 처럼 비동기 경계를 둔다(동시 요청이 await 지점에서 교차하도록) */
  tick() { return new Promise<void>((r) => setImmediate(r)); }
  prepare(sql: string): D1PreparedStatement { return new Stmt(this, sql); }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    await this.tick();
    if (this.failNextBatch) { const e = this.failNextBatch; this.failNextBatch = null; throw e; }
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((s) => (s as Stmt).exec());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
  async exec(sql: string) { this.raw.exec(sql); return {}; }
  /** wrangler d1 migrations 와 같은 방식: 적용된 파일명을 기록하고 새 파일만 순서대로 1회 적용(파일 단위 transaction) */
  migrate(dir: string): string[] {
    this.raw.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)');
    const done = new Set((this.raw.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      this.raw.exec('BEGIN');
      try { this.raw.exec(readFileSync(`${dir}/${f}`, 'utf8')); this.raw.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString()); this.raw.exec('COMMIT'); applied.push(f); }
      catch (e) { this.raw.exec('ROLLBACK'); throw new Error(`migration ${f} failed (rolled back): ${(e as Error).message}`); }
    }
    return applied;
  }
  close() { this.raw.close(); }
}
