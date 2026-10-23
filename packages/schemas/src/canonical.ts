// 02 §6: UTF-8 JSON, key 사전순, 배열 순서 보존, -0 은 0, 숫자는 JSON 표준 표현.
import { sha256Hex } from './sha256.ts';

export function canonicalStringify(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('NON_FINITE_NUMBER');
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'string': return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(write).join(',') + ']';
      const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + write((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    default: throw new Error('UNSERIALIZABLE_VALUE');
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value));
}

export async function snapshotHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalBytes(value));
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}
