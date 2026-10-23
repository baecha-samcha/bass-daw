// 02 §5 serialize/deserialize + §6 schemaVersion 처리.
import type { Project, Result } from './types.ts';
import { canonicalBytes } from './canonical.ts';
import { validateProject, LIMITS } from './validate.ts';

export const CURRENT_SCHEMA_VERSION = 1;

export function serializeProject(project: Project): Result<Uint8Array> {
  const v = validateProject(project);
  if (!v.ok) return v;
  return { ok: true, value: canonicalBytes(project) };
}

export interface DeserializeOk { project: Project; readOnly: boolean; schemaVersion: number }

/**
 * 크기 → JSON 파싱 → 버전 → 검증 순으로 처리한다.
 * 미래 schemaVersion 은 원본 바이트를 보존한 채 FUTURE_VERSION 으로 거절한다(쓰기 금지, 04 §4 read-only 보존).
 */
export function deserializeProject(bytes: Uint8Array): Result<Project> {
  if (bytes.byteLength > LIMITS.jsonBytes) return fail('INVALID_LIMIT', '$', 'JSON > 32MiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    return fail('INVALID_JSON', '$', (e as Error).message);
  }
  if (jsonDepth(parsed) > LIMITS.nesting) return fail('INVALID_LIMIT', '$', 'nesting > 32');
  const sv = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof sv === 'number' && sv > CURRENT_SCHEMA_VERSION) return fail('FUTURE_VERSION', '$.schemaVersion', `schemaVersion ${sv} is newer than supported ${CURRENT_SCHEMA_VERSION}; opened read-only`);
  const migrated = migrate(parsed);
  if (!migrated.ok) return migrated;
  return validateProject(migrated.value);
}

/** n→n+1 순수 migration 체인. v1 이 첫 배포 포맷이므로 현재 단계는 없다. */
export type Migration = (input: unknown) => Result<unknown>;
export const MIGRATIONS: Record<number, Migration> = {};

export function migrate(input: unknown, migrations: Record<number, Migration> = MIGRATIONS): Result<unknown> {
  let cur = structuredClone(input) as { schemaVersion?: unknown };
  let guard = 0;
  while (typeof cur?.schemaVersion === 'number' && cur.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const m = migrations[cur.schemaVersion];
    if (!m || guard++ > 64) return fail('MIGRATION_FAILED', '$.schemaVersion', `no migration from ${cur.schemaVersion}`);
    const r = m(cur);
    if (!r.ok) return r;
    cur = r.value as { schemaVersion?: unknown };
  }
  return { ok: true, value: cur };
}

export function jsonDepth(v: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > max) max = d;
    if (d > 64) return d;
    if (x && typeof x === 'object') for (const y of Object.values(x)) stack.push([y, d + 1]);
  }
  return max;
}

function fail<T>(code: string, path: string, message: string): Result<T> {
  return { ok: false, errors: [{ code, path, message }] };
}
