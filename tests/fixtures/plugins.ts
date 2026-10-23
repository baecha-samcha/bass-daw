// 플러그인 fixture: WAT → wasm(wabt) → 번들. 부정 입력은 sample gain 을 변형해 만든다(F06).
import wabtInit from 'wabt';
import { readFileSync } from 'node:fs';
import { buildBundle } from '@bass-daw/plugin-api';
import type { PluginManifest } from '@bass-daw/schemas';

let wabt: Awaited<ReturnType<typeof wabtInit>> | null = null;
export async function wat2wasm(src: string, features: Record<string, boolean> = {}): Promise<Uint8Array> {
  wabt ??= await wabtInit();
  const m = wabt.parseWat('x.wat', src, features);
  return new Uint8Array(m.toBinary({}).buffer);
}
export const sample = (name: string) => ({ manifest: JSON.parse(readFileSync(`plugins/${name}/manifest.json`, 'utf8')) as PluginManifest, wat: readFileSync(`plugins/${name}/dsp.wat`, 'utf8'), ui: (() => { try { return readFileSync(`plugins/${name}/ui.html`, 'utf8'); } catch { return undefined; } })() });

export async function bundleOf(name: string, mutate: { wat?: (s: string) => string; manifest?: (m: PluginManifest) => PluginManifest; features?: Record<string, boolean> } = {}): Promise<Uint8Array> {
  const s = sample(name);
  const wasm = await wat2wasm(mutate.wat ? mutate.wat(s.wat) : s.wat, mutate.features);
  const m = mutate.manifest ? mutate.manifest(structuredClone(s.manifest)) : s.manifest;
  return buildBundle(m as never, wasm, m.ui ? s.ui : undefined);
}

/** 무한 루프 process (P06 watchdog 전용) */
export const LOOP = (s: string) => s.replace('(local $i i32) (local $off i32)\n    (block $done', '(local $i i32) (local $off i32)\n    (loop $forever (br $forever))\n    (block $done');
export const BAD_IMPORT = (s: string) => s.replace('(module', '(module\n  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))');
export const BAD_ABI = (s: string) => s.replace('(i32.const 0x00010000)', '(i32.const 0x00020000)');
export const BAD_SIG = (s: string) => s.replace('(func (export "process") (param $h i32) (param $n i32) (param $ev i32) (result i32)', '(func (export "process") (param $h i32) (param $n i32) (result i32) (local $ev i32)');
export const BAD_PTR = (s: string) => s.replace('(func (export "output_ptr") (param $h i32) (param $c i32) (result i32) (i32.add (i32.const 5120)', '(func (export "output_ptr") (param $h i32) (param $c i32) (result i32) (i32.add (i32.const 70000)');
export const NO_MAX = (s: string) => s.replace('(memory (export "memory") 1 1)', '(memory (export "memory") 1)');
export const BIG_MEM = (s: string) => s.replace('(memory (export "memory") 1 1)', '(memory (export "memory") 1 4)');
export const TRAP_AFTER = (s: string) => s.replace('(local $i i32) (local $off i32)\n    (block $done', '(local $i i32) (local $off i32)\n    (if (f32.gt (f32.load (i32.const 41984)) (f32.const 3)) (then unreachable))\n    (block $done');
