// 03 §4 PluginHost: inspect → install(승인 hash) → instantiate → setParameter/restore/bypass/dispose.
// 상태: discovered→validated→installed→prepared→active→bypassed/disposed, fault 시 faulted→bypassed(자동 재시작 없음).
import type { PluginManifest, Result, Json, Id } from '@bass-daw/schemas';
import { inspectBundle, type InspectedPlugin } from './bundle.ts';
import { pluginKey } from './manifest.ts';

export type InstallState = 'discovered' | 'validated' | 'installed';
export type InstanceState = 'prepared' | 'active' | 'bypassed' | 'faulted' | 'disposed';

export interface InstalledPlugin { key: string; manifest: PluginManifest; bundleHash: string; memoryPages: number; installedAt: string; conformance: unknown }
export interface PluginRegistryStore {
  list(): Promise<InstalledPlugin[]>;
  get(key: string): Promise<{ record: InstalledPlugin; bundle: Uint8Array } | null>;
  put(record: InstalledPlugin, bundle: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}
/**
 * 외부 DSP 실행 정책(D05): 저장소 리뷰를 거친 고정 bundle hash 만 설치·실행한다.
 * 사용자 승인은 필요조건일 뿐 충분조건이 아니다(로컬 파일 설치도 이 목록을 통과해야 한다).
 */
export interface ReviewPolicy { isReviewed(pluginId: string, version: string, bundleHash: string): boolean }
export function reviewedList(entries: { pluginId: string; version: string; bundleSha256: string }[]): ReviewPolicy {
  const ok = new Set(entries.map((e) => `${e.pluginId}@${e.version}#${e.bundleSha256}`));
  return { isReviewed: (id, v, h) => ok.has(`${id}@${v}#${h}`) };
}
/** 설치 전 시험 렌더 실행기(Worker+watchdog 등). 무한 루프/시간 초과면 ok:false */
export type TestRunner = (p: InspectedPlugin) => Promise<{ ok: boolean; report: unknown; reason?: string }>;

const fail = <T>(code: string, message: string): Result<T> => ({ ok: false, errors: [{ code, path: '$', message }] });

export class PluginHost {
  private pending = new Map<string, InspectedPlugin>(); // validated, not installed
  private instances = new Map<Id, { key: string; phase: InstanceState; parameters: Record<string, number>; stateVersion: number; data: Json; bypass: boolean; fault: string | null }>();
  private compiled = new Map<string, Promise<{ module: WebAssembly.Module; dsp: Uint8Array }>>();
  constructor(private store: PluginRegistryStore, private test: TestRunner, readonly policy: ReviewPolicy) {}

  reviewed(r: { manifest: PluginManifest; bundleHash: string }): boolean { return this.policy.isReviewed(r.manifest.pluginId, r.manifest.version, r.bundleHash); }

  async inspect(bytes: Uint8Array): Promise<Result<PluginManifest & { bundleHash: string }>> {
    const r = await inspectBundle(bytes);
    if (!r.ok) return r as Result<never>;
    this.pending.set(r.value.bundleHash, r.value);
    return { ok: true, value: { ...r.value.manifest, bundleHash: r.value.bundleHash } };
  }

  /** 정지 중 설치: 승인 hash 확인 → 시험 렌더(watchdog) → 영속화. 실행 중 업데이트·자동 신뢰 없음. */
  async install(manifest: PluginManifest, approvedHash: string, bundle: Uint8Array): Promise<Result<string>> {
    const p = this.pending.get(approvedHash);
    if (!p || p.manifest.pluginId !== manifest.pluginId || p.manifest.version !== manifest.version) return fail('NOT_VALIDATED', 'inspect the exact bundle first');
    if (p.bundleHash !== approvedHash) return fail('HASH_MISMATCH', 'approved hash differs');
    if (!this.reviewed(p)) return fail('PLUGIN_NOT_REVIEWED', `${manifest.pluginId}@${manifest.version} bundle ${approvedHash.slice(0, 12)}… is not on the reviewed list; external DSP is limited to reviewed fixed hashes`);
    const key = pluginKey(manifest.pluginId, manifest.version);
    const existing = await this.store.get(key);
    if (existing && existing.record.bundleHash !== approvedHash) return fail('VERSION_CONFLICT', `${key} already installed with a different hash; bump the version`);
    const t = await this.test(p);
    if (!t.ok) return fail('TEST_RENDER_FAILED', t.reason ?? 'conformance failed');
    await this.store.put({ key, manifest: p.manifest, bundleHash: p.bundleHash, memoryPages: p.memoryPages, installedAt: new Date().toISOString(), conformance: t.report }, bundle);
    this.pending.delete(approvedHash);
    return { ok: true, value: key };
  }

  /** 설치된 번들을 다시 검증해 내용(UI html 등)을 돌려준다 */
  async installedBundle(key: string): Promise<InspectedPlugin | null> {
    const got = await this.store.get(key);
    if (!got || !this.reviewed(got.record)) return null;
    const r = await inspectBundle(got.bundle);
    return r.ok && r.value.bundleHash === got.record.bundleHash ? r.value : null;
  }

  async uninstall(key: string) { await this.store.remove(key); this.compiled.delete(key); }
  list() { return this.store.list(); }

  /** 정확한 version + hash 로 모듈 준비 (pinnedHash 가 다르면 미설치 취급) */
  async module(pluginId: string, version: string, pinnedHash?: string | null): Promise<{ record: InstalledPlugin; module: WebAssembly.Module; dsp: Uint8Array } | null> {
    const key = pluginKey(pluginId, version);
    const got = await this.store.get(key);
    if (!got || (pinnedHash && got.record.bundleHash !== pinnedHash)) return null;
    // 정책 이전에 설치됐거나 저장소에서 바뀐 항목도 실행하지 않는다
    if (!this.reviewed(got.record)) return null;
    let m = this.compiled.get(key);
    if (!m) {
      m = inspectBundle(got.bundle).then(async (r) => { if (!r.ok || r.value.bundleHash !== got.record.bundleHash) throw new Error('installed bundle failed re-verification'); return { module: await WebAssembly.compile(r.value.dsp as unknown as BufferSource), dsp: r.value.dsp }; });
      this.compiled.set(key, m);
    }
    try { return { record: got.record, ...(await m) }; } catch { this.compiled.delete(key); return null; }
  }

  async instantiate(pluginId: string, version: string, instanceId: Id): Promise<Result<void>> {
    const key = pluginKey(pluginId, version);
    const got = await this.store.get(key);
    if (!got) return fail('PLUGIN_MISSING', key);
    this.instances.set(instanceId, { key, phase: 'prepared', parameters: Object.fromEntries(got.record.manifest.parameters.map((d) => [d.id, d.default])), stateVersion: got.record.manifest.stateVersion, data: null, bypass: false, fault: null });
    return { ok: true, value: undefined };
  }

  async setParameter(instanceId: Id, parameterId: string, value: number): Promise<Result<void>> {
    const i = this.instances.get(instanceId); if (!i) return fail('UNKNOWN_INSTANCE', instanceId);
    const m = (await this.store.get(i.key))!.record.manifest;
    const d = m.parameters.find((x) => x.id === parameterId);
    if (!d) return fail('UNKNOWN_PARAMETER', parameterId);
    if (!(value >= d.min && value <= d.max)) return fail('OUT_OF_RANGE', `${parameterId} ${value} not in ${d.min}..${d.max}`);
    i.parameters[parameterId] = value;
    return { ok: true, value: undefined };
  }

  /** state 복원: 버전이 다르면 migration 필요(v1 은 migration 없음 → 거절, 원본 state 보존) */
  async restore(instanceId: Id, stateVersion: number, state: Json): Promise<Result<void>> {
    const i = this.instances.get(instanceId); if (!i) return fail('UNKNOWN_INSTANCE', instanceId);
    const m = (await this.store.get(i.key))!.record.manifest;
    if (stateVersion !== m.stateVersion) return fail('MIGRATION_REQUIRED', `state v${stateVersion} → v${m.stateVersion}; original state kept`);
    if (JSON.stringify(state).length > m.maxStateBytes) return fail('STATE_TOO_LARGE', `> ${m.maxStateBytes}`);
    i.data = state; i.stateVersion = stateVersion; i.phase = 'active';
    return { ok: true, value: undefined };
  }

  bypass(instanceId: Id, enabled: boolean): Result<void> {
    const i = this.instances.get(instanceId); if (!i) return fail('UNKNOWN_INSTANCE', instanceId);
    i.bypass = enabled; i.phase = enabled ? 'bypassed' : i.fault ? 'bypassed' : 'active';
    return { ok: true, value: undefined };
  }

  /** 렌더 스레드가 보고한 fault: faulted→bypassed. 자동 재시작하지 않는다. */
  reportFault(instanceId: Id, reason: string) { const i = this.instances.get(instanceId); if (i) { i.fault = reason; i.phase = 'faulted'; i.bypass = true; i.phase = 'bypassed'; } }
  instanceInfo(instanceId: Id) { const i = this.instances.get(instanceId); return i ? { ...i } : null; }
  async dispose(instanceId: Id): Promise<void> { const i = this.instances.get(instanceId); if (i) i.phase = 'disposed'; this.instances.delete(instanceId); }
}
