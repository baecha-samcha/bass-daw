// 프로젝트 파일 .dawbae (이전 .bassdaw 호환) (ZIP): manifest.json, project.json, assets/<sha256>
import type { Project, Result, Id } from '@bass-daw/schemas';
import { deserializeProject, serializeProject, sha256Hex, SHA256_RE, uuid, nowIso, validateProject, Sha256 } from '@bass-daw/schemas';
import { writeZip, readZipDirectory, readZipEntry, ZIP_LIMITS, crc32, type ZipEntry } from './zip.ts';
import type { LocalStore } from './local-store.ts';

export interface ArchiveManifest {
  archiveVersion: 1;
  snapshotHash: string;
  projectId: Id;
  createdAt: string;
  entries: { path: string; bytes: number; sha256: string }[];
  plugins: { pluginId: string; version: string; hash: string | null }[];
  requiredExternal: { sha256: string; reason: 'redistribution-forbidden' | 'missing-bytes' }[];
  portable: 'complete' | 'requires-external';
}

export async function exportArchive(store: LocalStore, projectId: Id, revisionId?: Id): Promise<Result<{ blob: Blob; manifest: ArchiveManifest }>> {
  const o = await store.open(projectId, revisionId);
  if (!o.ok) return o as Result<never>;
  return createProjectArchive(o.value.project, h => store.readAsset(h));
}

/** File save uses the current immutable project, even when the browser recovery commit failed. */
export async function createProjectArchive(p: Project, readAsset: (hash: string) => Promise<Blob | null>, options: { localFile?: boolean } = {}): Promise<Result<{ blob: Blob; manifest: ArchiveManifest }>> {
  const ser = serializeProject(p);
  if (!ser.ok) return ser as Result<never>;
  const snapshotHash = await sha256Hex(ser.value);
  const entries: { name: string; data: Blob | Uint8Array; compress?: boolean }[] = [];
  const manifest: ArchiveManifest = {
    archiveVersion: 1, snapshotHash, projectId: p.id, createdAt: nowIso(),
    entries: [{ path: 'project.json', bytes: ser.value.length, sha256: snapshotHash }],
    plugins: [...new Map(p.plugins.map((x) => [`${x.pluginId}@${x.pluginVersion}`, { pluginId: x.pluginId, version: x.pluginVersion, hash: p.metadata[`pluginHash:${x.pluginId}@${x.pluginVersion}`] ?? null }])).values()],
    requiredExternal: [], portable: 'complete',
  };
  const seen = new Set<string>();
  for (const a of p.assets) {
    if (seen.has(a.sha256)) continue;
    seen.add(a.sha256);
    if (!options.localFile && a.license.redistribution === 'forbidden') { manifest.requiredExternal.push({ sha256: a.sha256, reason: 'redistribution-forbidden' }); continue; }
    const blob = await readAsset(a.sha256);
    if (!blob || blob.size !== a.byteLength) { manifest.requiredExternal.push({ sha256: a.sha256, reason: 'missing-bytes' }); continue; }
    entries.push({ name: `assets/${a.sha256}`, data: blob });
    manifest.entries.push({ path: `assets/${a.sha256}`, bytes: blob.size, sha256: a.sha256 });
  }
  if (manifest.requiredExternal.length) {
    if (options.localFile) return fail('MISSING_FILE_ASSETS', `Cannot save a complete .dawbae file: ${manifest.requiredExternal.length} asset(s) missing. Existing file is unchanged.`);
    manifest.portable = 'requires-external';
  }
  const mbytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const blob = await writeZip([{ name: 'manifest.json', data: mbytes, compress: true }, { name: 'project.json', data: ser.value, compress: true }, ...entries]);
  return { ok: true, value: { blob, manifest } };
}

const fail = <T>(code: string, message: string): Result<T> => ({ ok: false, errors: [{ code, path: '$', message }] });
const ALLOWED = /^(manifest\.json|project\.json|assets\/[0-9a-f]{64})$/;

/** 새 project ID 로 복원. 모든 entry 검증과 새 로컬 commit 성공 후에만 완료. 기존 프로젝트는 건드리지 않는다. */
export async function importArchive(store: LocalStore, file: Blob, limits = ZIP_LIMITS): Promise<Result<{ projectId: Id; missing: string[]; manifest: ArchiveManifest }>> {
  const dir = await readZipDirectory(file, limits);
  if (!dir.ok) return fail(dir.code, dir.message);
  const byName = new Map<string, ZipEntry>();
  for (const e of dir.value) {
    if (!ALLOWED.test(e.name)) return fail('ARCHIVE_PATH', `unexpected entry ${e.name}`);
    byName.set(e.name, e);
  }
  const me = byName.get('manifest.json'), pe = byName.get('project.json');
  if (!me || !pe) return fail('ARCHIVE_INVALID', 'manifest.json and project.json required');
  if (me.usize > 1024 * 1024) return fail('ARCHIVE_LIMIT', 'manifest too large');
  const mb = await readZipEntry(file, me);
  if (!mb.ok) return fail(mb.code, mb.message);
  let manifest: ArchiveManifest;
  try { manifest = JSON.parse(new TextDecoder().decode(mb.value)); } catch { return fail('ARCHIVE_INVALID', 'manifest is not JSON'); }
  if (manifest.archiveVersion !== 1) return fail('ARCHIVE_INVALID', `unsupported archiveVersion ${manifest.archiveVersion}`);
  const pb = await readZipEntry(file, pe);
  if (!pb.ok) return fail(pb.code, pb.message);
  if (await sha256Hex(pb.value) !== manifest.snapshotHash) return fail('HASH_MISMATCH', 'project.json hash differs from manifest');
  const d = deserializeProject(pb.value);
  if (!d.ok) return d as Result<never>;
  const original = d.value;
  // 자산 검증 + import (모두 성공해야 commit)
  const needed = new Set(original.assets.map((a) => a.sha256));
  const missing: string[] = [];
  for (const h of needed) {
    const e = byName.get(`assets/${h}`);
    if (!e) { missing.push(h); continue; }
    const declared = manifest.entries.find((x) => x.path === e.name);
    if (!declared || declared.sha256 !== h || declared.bytes !== e.usize) return fail('HASH_MISMATCH', `manifest entry mismatch for ${e.name}`);
    let data: Blob | Uint8Array;
    if (e.method === 0) {
      // stored: 메모리 복사 없이 slice 를 스트리밍 검증
      const lh = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
      const start = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      data = file.slice(start, start + e.csize);
      let c = 0; const sh = new Sha256();
      for (let i = 0; i < e.csize; i += 1 << 20) { const u = new Uint8Array(await (data as Blob).slice(i, i + (1 << 20)).arrayBuffer()); c = crc32(u, c); sh.update(u); }
      if (c !== e.crc) return fail('ARCHIVE_INVALID', `crc mismatch ${e.name}`);
      if (sh.digestHex() !== h) return fail('HASH_MISMATCH', `asset bytes do not match ${h}`);
    } else {
      const r = await readZipEntry(file, e);
      if (!r.ok) return fail(r.code, r.message);
      data = r.value;
    }
    const imp = await store.importAsset(data, h);
    if (!imp.ok) return imp as Result<never>;
  }
  for (const h of byName.keys()) if (h.startsWith('assets/') && !needed.has(h.slice(7))) return fail('ARCHIVE_INVALID', `unreferenced asset ${h}`);
  const now = nowIso();
  const copy: Project = {
    ...original, id: uuid(), updatedAt: now > original.updatedAt ? now : original.updatedAt,
    metadata: { ...original.metadata, originProjectId: original.id },
  };
  const v = validateProject(copy);
  if (!v.ok) return v as Result<never>;
  const lease = await store.acquireLease(copy.id);
  if (!lease.ok) return lease as Result<never>;
  const c = await store.commit(copy, null, 0);
  if (!c.ok) return c as Result<never>;
  return { ok: true, value: { projectId: copy.id, missing, manifest } };
}

export { SHA256_RE };
