// 플러그인 번들(.bdplugin) = ZIP { manifest.json, <dsp.path>, <ui.path>? }. 번들 전체 SHA-256 이 설치 승인 hash.
import { unzipSync, zipSync, strToU8 } from 'fflate';
import type { PluginManifest, Result } from '@bass-daw/schemas';
import { sha256Hex } from '@bass-daw/schemas';
import { validateManifest } from './manifest.ts';
import { parseWasm, checkModule, type ModuleInfo } from './wasm-binary.ts';

export const BUNDLE_LIMITS = { bundleBytes: 8 * 1024 * 1024, uncompressedBytes: 32 * 1024 * 1024, uiBytes: 256 * 1024 };

export interface InspectedPlugin { manifest: PluginManifest; bundleHash: string; dsp: Uint8Array; ui: string | null; module: ModuleInfo; memoryPages: number }

const fail = <T>(code: string, message: string): Result<T> => ({ ok: false, errors: [{ code, path: '$', message }] });

export async function inspectBundle(bytes: Uint8Array): Promise<Result<InspectedPlugin>> {
  if (bytes.length > BUNDLE_LIMITS.bundleBytes) return fail('BUNDLE_TOO_LARGE', `bundle > ${BUNDLE_LIMITS.bundleBytes} bytes`);
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > BUNDLE_LIMITS.uncompressedBytes || f.originalSize > BUNDLE_LIMITS.uncompressedBytes) throw new Error('BUNDLE_TOO_LARGE uncompressed');
        if (f.name.includes('/') || f.name.includes('\\') || f.name.startsWith('.')) throw new Error(`BUNDLE_PATH ${f.name}`);
        return true;
      },
    });
  } catch (e) { return fail('BUNDLE_INVALID', (e as Error).message); }
  const mbytes = files['manifest.json'];
  if (!mbytes) return fail('BUNDLE_INVALID', 'manifest.json missing');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mbytes)); } catch { return fail('MANIFEST_INVALID', 'manifest.json is not JSON'); }
  const mv = validateManifest(raw);
  if (!mv.ok) return mv as Result<never>;
  const m = mv.value;
  const allowed = new Set(['manifest.json', m.dsp.path, ...(m.ui ? [m.ui.path] : [])]);
  for (const n of Object.keys(files)) if (!allowed.has(n)) return fail('BUNDLE_INVALID', `unexpected file ${n}`);
  const dsp = files[m.dsp.path];
  if (!dsp) return fail('BUNDLE_INVALID', `${m.dsp.path} missing`);
  if (await sha256Hex(dsp) !== m.dsp.sha256) return fail('HASH_MISMATCH', 'dsp sha256 differs from manifest');
  let ui: string | null = null;
  if (m.ui) {
    const u = files[m.ui.path];
    if (!u) return fail('BUNDLE_INVALID', `${m.ui.path} missing`);
    if (u.length > BUNDLE_LIMITS.uiBytes) return fail('BUNDLE_TOO_LARGE', 'ui > 256KiB');
    if (await sha256Hex(u) !== m.ui.sha256) return fail('HASH_MISMATCH', 'ui sha256 differs from manifest');
    ui = new TextDecoder().decode(u);
  }
  let info: ModuleInfo;
  try { info = parseWasm(dsp); } catch (e) { return fail('WASM_INVALID', (e as Error).message); }
  const errs = checkModule(info, m.maxMemoryPages);
  if (errs.length) return { ok: false, errors: errs.map((x) => ({ code: x.split(' ')[0], path: '$.dsp', message: x })) };
  try { await WebAssembly.compile(dsp as unknown as BufferSource); } catch (e) { return fail('WASM_INVALID', `compile failed: ${(e as Error).message}`); }
  return { ok: true, value: { manifest: m, bundleHash: await sha256Hex(bytes), dsp, ui, module: info, memoryPages: info.memories[0].max! } };
}

/** 번들 작성(빌드 스크립트·테스트용): dsp/ui hash 를 manifest 에 채운다 */
export async function buildBundle(manifest: Omit<PluginManifest, 'dsp' | 'ui'> & { dsp: { abi: 'bass-daw-wasm-1'; path: string }; ui: null | { path: string } }, dsp: Uint8Array, ui?: string): Promise<Uint8Array> {
  const m: PluginManifest = {
    ...manifest,
    dsp: { ...manifest.dsp, sha256: await sha256Hex(dsp) },
    ui: manifest.ui && ui !== undefined ? { path: manifest.ui.path, sha256: await sha256Hex(strToU8(ui)) } : null,
  } as PluginManifest;
  const files: Record<string, [Uint8Array, { level: 0 | 6; mtime: Date }]> = { 'manifest.json': [strToU8(JSON.stringify(m, null, 2)), { level: 6, mtime: new Date(Date.UTC(2026, 9, 22)) }], [m.dsp.path]: [dsp, { level: 6, mtime: new Date(Date.UTC(2026, 9, 22)) }] };
  if (m.ui && ui !== undefined) files[m.ui.path] = [strToU8(ui), { level: 6, mtime: new Date(Date.UTC(2026, 9, 22)) }];
  return zipSync(files as never);
}
