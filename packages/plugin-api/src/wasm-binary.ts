// WASM 바이너리 정적 검사(03 §3): import allowlist, 메모리 1개·비공유·최대 확정, export 시그니처.
// WebAssembly JS API 는 함수 시그니처·메모리 limits 를 노출하지 않으므로 section 을 직접 읽는다.

export type ValType = 'i32' | 'i64' | 'f32' | 'f64';
export interface FuncType { params: ValType[]; results: ValType[] }
export interface ModuleInfo {
  types: FuncType[];
  imports: { module: string; name: string; kind: 'func' | 'table' | 'memory' | 'global'; type?: FuncType }[];
  memories: { min: number; max: number | null; shared: boolean; imported: boolean }[];
  exports: { name: string; kind: 'func' | 'table' | 'memory' | 'global'; type?: FuncType }[];
}

const VT: Record<number, ValType> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' };
const KIND = ['func', 'table', 'memory', 'global'] as const;

export function parseWasm(bytes: Uint8Array): ModuleInfo {
  let p = 0;
  const fail = (m: string): never => { throw new Error(`WASM_INVALID: ${m}`); };
  const u8 = () => (p < bytes.length ? bytes[p++] : fail('unexpected end'));
  const leb = () => { let r = 0, s = 0, b; do { b = u8(); r |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 35); return r >>> 0; };
  const name = () => { const n = leb(); const v = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return v; };
  const limits = () => { const flag = u8(); const min = leb(); const max = flag & 1 ? leb() : null; return { min, max, shared: (flag & 2) !== 0 }; };
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail('bad magic');
  if (bytes[4] !== 1) fail('unsupported version');
  p = 8;
  const info: ModuleInfo = { types: [], imports: [], memories: [], exports: [] };
  const funcTypes: number[] = [];
  const exportsRaw: { name: string; kind: number; index: number }[] = [];
  while (p < bytes.length) {
    const id = u8(); const size = leb(); const end = p + size;
    if (end > bytes.length) fail('section overflow');
    if (id === 1) {
      const n = leb();
      for (let i = 0; i < n; i++) {
        if (u8() !== 0x60) fail('bad functype');
        const params = Array.from({ length: leb() }, () => VT[u8()] ?? fail('bad valtype'));
        const results = Array.from({ length: leb() }, () => VT[u8()] ?? fail('bad valtype'));
        info.types.push({ params, results });
      }
    } else if (id === 2) {
      const n = leb();
      for (let i = 0; i < n; i++) {
        const module = name(), field = name(); const k = u8();
        if (k === 0) { const t = leb(); funcTypes.push(t); info.imports.push({ module, name: field, kind: 'func', type: info.types[t] }); }
        else if (k === 1) { u8(); limits(); info.imports.push({ module, name: field, kind: 'table' }); }
        else if (k === 2) { const l = limits(); info.memories.push({ ...l, imported: true }); info.imports.push({ module, name: field, kind: 'memory' }); }
        else if (k === 3) { u8(); u8(); info.imports.push({ module, name: field, kind: 'global' }); }
        else fail('bad import kind');
      }
    } else if (id === 3) {
      const n = leb(); for (let i = 0; i < n; i++) funcTypes.push(leb());
    } else if (id === 5) {
      const n = leb(); for (let i = 0; i < n; i++) info.memories.push({ ...limits(), imported: false });
    } else if (id === 7) {
      const n = leb(); for (let i = 0; i < n; i++) exportsRaw.push({ name: name(), kind: u8(), index: leb() });
    }
    p = end;
  }
  for (const e of exportsRaw) {
    const kind = KIND[e.kind] ?? fail('bad export kind');
    info.exports.push({ name: e.name, kind, type: kind === 'func' ? info.types[funcTypes[e.index]] : undefined });
  }
  return info;
}

/** ABI 1 export 시그니처 (03 §3) */
export const ABI1_EXPORTS: Record<string, FuncType> = {
  abi_version: { params: [], results: ['i32'] },
  create: { params: ['f32', 'i32'], results: ['i32'] },
  alloc: { params: ['i32'], results: ['i32'] },
  free: { params: ['i32'], results: [] },
  configure: { params: ['i32', 'i32', 'i32'], results: ['i32'] },
  bind_sample: { params: ['i32', 'i32', 'i32', 'i32', 'i32', 'f32'], results: ['i32'] },
  input_ptr: { params: ['i32', 'i32'], results: ['i32'] },
  output_ptr: { params: ['i32', 'i32'], results: ['i32'] },
  events_ptr: { params: ['i32'], results: ['i32'] },
  params_ptr: { params: ['i32'], results: ['i32'] },
  process: { params: ['i32', 'i32', 'i32'], results: ['i32'] },
  reset: { params: ['i32'], results: ['i32'] },
  destroy: { params: ['i32'], results: [] },
};
export const ABI1_VERSION = 0x00010000;

/** 허용 import: host 수학 함수만 (WASI·clock·filesystem·network 거절) */
const F64_1: FuncType = { params: ['f64'], results: ['f64'] };
export const HOST_IMPORTS: Record<string, { type: FuncType; fn: (...a: number[]) => number }> = {
  sin: { type: F64_1, fn: Math.sin }, cos: { type: F64_1, fn: Math.cos }, tan: { type: F64_1, fn: Math.tan },
  exp: { type: F64_1, fn: Math.exp }, log: { type: F64_1, fn: Math.log }, tanh: { type: F64_1, fn: Math.tanh },
  sqrt: { type: F64_1, fn: Math.sqrt }, pow: { type: { params: ['f64', 'f64'], results: ['f64'] }, fn: Math.pow },
};

const sameType = (a?: FuncType, b?: FuncType) => !!a && !!b && a.params.join() === b.params.join() && a.results.join() === b.results.join();

export function checkModule(info: ModuleInfo, maxMemoryPages: number): string[] {
  const errs: string[] = [];
  for (const im of info.imports) {
    const allowed = im.module === 'host' && im.kind === 'func' ? HOST_IMPORTS[im.name] : undefined;
    if (!allowed) errs.push(`IMPORT_FORBIDDEN ${im.module}.${im.name} (${im.kind})`);
    else if (!sameType(allowed.type, im.type)) errs.push(`IMPORT_SIGNATURE ${im.module}.${im.name}`);
  }
  if (info.memories.length !== 1) errs.push(`MEMORY_COUNT ${info.memories.length} (exactly 1 required)`);
  for (const m of info.memories) {
    if (m.imported) errs.push('MEMORY_IMPORTED');
    if (m.shared) errs.push('MEMORY_SHARED');
    if (m.max === null) errs.push('MEMORY_NO_MAXIMUM');
    else if (m.max > maxMemoryPages) errs.push(`MEMORY_MAX ${m.max} > manifest.maxMemoryPages ${maxMemoryPages}`);
    if (m.max !== null && m.max > 1024) errs.push('MEMORY_OVER_64MIB');
  }
  if (!info.exports.some((e) => e.name === 'memory' && e.kind === 'memory')) errs.push('EXPORT_MISSING memory');
  for (const [n, t] of Object.entries(ABI1_EXPORTS)) {
    const e = info.exports.find((x) => x.name === n);
    if (!e || e.kind !== 'func') errs.push(`EXPORT_MISSING ${n}`);
    else if (!sameType(e.type, t)) errs.push(`EXPORT_SIGNATURE ${n} expected (${t.params}) -> (${t.results})`);
  }
  return errs;
}
