// 앱 상태(Zustand). 도메인 로직은 packages/* 에 있고 여기서는 연결만 한다.
import { create } from 'zustand';
import type { Project, Id, Asset, TrackKind } from '@bass-daw/schemas';
import { createEmptyProject, uuid, nowIso } from '@bass-daw/schemas';
import { ProjectSession, type CommandPayload } from '@bass-daw/project-core';
import { LocalStore, OpfsByteStore, IdbByteStore, AutosaveController, createProjectArchive, importArchive, HEARTBEAT_MS, type ProjectRecord, type SaveStatus, type ByteStore } from '@bass-daw/storage';
import { synthKit, KIT_LICENSE, KIT_SAMPLE_RATE, type KitName } from '@bass-daw/audio-engine';
import { engine } from './audio/engine.ts';
import type { PluginHost, InstalledPlugin } from '@bass-daw/plugin-api';
import { projectFileName, pickSaveFile, writeProjectFile, isFileCancelled, type ProjectFileHandle, type ProjectFilePicker } from './files/project-file.ts';
import { createPluginHost } from './plugins/registry.ts';

export interface Selection { trackId: Id | null; clipId: Id | null; noteIds: string[] }
export interface Toast { id: number; kind: 'info' | 'error' | 'warn'; text: string }

interface AppState {
  store: LocalStore | null;
  storageKind: ByteStore['kind'] | 'none';
  storageError: string | null;
  persisted: boolean | null;
  projects: ProjectRecord[];
  session: ProjectSession | null;
  project: Project | null;
  editSeq: number;
  fileHandle: ProjectFileHandle | null;
  fileName: string | null;
  fileSavedSeq: number | null;
  fileState: 'unsaved' | 'saving' | 'saved' | 'downloaded' | 'error';
  fileError: string | null;
  fileBusy: boolean;
  saveProjectFile(options?: { saveAs?: boolean; download?: boolean }): Promise<void>;
  openProjectFile(file: File, handle?: ProjectFileHandle): Promise<void>;
  saveStatus: SaveStatus;
  saveError: string | null;
  readOnly: string | null;
  missing: string[];
  openDiagnostics: string[];
  selection: Selection;
  pxPerBeat: number;
  snap: number; // ticks
  toasts: Toast[];
  updateReady: boolean;
  view: 'home' | 'editor' | 'diagnostics' | 'score-check';
  panel: 'editor' | 'mixer' | 'automation' | 'record' | 'export' | 'engine' | 'plugins' | 'sync' | 'files' | 'score';
  pluginHost: PluginHost | null;
  installedPlugins: InstalledPlugin[];
  refreshPlugins(): Promise<void>;

  init(): Promise<void>;
  refreshProjects(): Promise<void>;
  newProject(title?: string): Promise<void>;
  openProject(id: Id, opts?: { takeover?: boolean }): Promise<void>;
  closeProject(): Promise<void>;
  run(label: string, c: CommandPayload): boolean;
  undo(): void; redo(): void;
  saveNow(): Promise<void>;
  select(s: Partial<Selection>): void;
  toast(kind: Toast['kind'], text: string): void;
  addInstrumentTrack(kind: TrackKind, instrument?: 'bass' | 'guitar'): Promise<void>;
  exportBackup(): Promise<void>;
  importBackup(file: File): Promise<void>;
  set(p: Partial<AppState>): void;
}

let autosave: AutosaveController | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let unsub: (() => void) | null = null;
let lockRelease: (() => void) | null = null;
let toastId = 0;
/** 로컬 commit 완료 알림(클라우드 동기화 등 다른 계층이 구독). 저장 성공과 원격 동기화 성공은 별개다. */
export const commitListeners = new Set<(projectId: string) => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bass-daw') : null;

export const useApp = create<AppState>((set, get) => ({
  store: null, storageKind: 'none', storageError: null, persisted: null, projects: [],
  session: null, project: null, editSeq: 0, fileHandle: null, fileName: null, fileSavedSeq: null, fileState: 'unsaved', fileError: null, fileBusy: false, saveStatus: 'clean', saveError: null, readOnly: null, missing: [], openDiagnostics: [],
  selection: { trackId: null, clipId: null, noteIds: [] }, pxPerBeat: 48, snap: 240, toasts: [], updateReady: false, view: 'home', panel: 'editor', pluginHost: null, installedPlugins: [],

  set: (p) => set(p),

  async init() {
    let bytes: ByteStore | null = await OpfsByteStore.open();
    if (bytes) {
      try { await bytes.write('cache/probe', new Uint8Array([1])); await bytes.remove('cache/probe'); }
      catch { bytes = null; }
    }
    if (!bytes) bytes = IdbByteStore.open('bass-daw-blobs');
    try {
      const store = await LocalStore.open(bytes);
      set({ store, storageKind: bytes.kind });
      const p = await store.persist();
      set({ persisted: p.persisted });
      engine.loadAsset = (h) => store.readAsset(h);
      const host = createPluginHost(store);
      engine.pluginResolver = (id, v, pinned) => host.module(id, v, pinned);
      set({ pluginHost: host });
      await get().refreshPlugins();
      await get().refreshProjects();
    } catch (e) {
      // 둘 다 불가: 메모리 편집과 즉시 백업 출력만 허용, 저장 성공으로 표시하지 않음
      set({ storageError: `Local storage unavailable: ${(e as Error).message}. Edits stay in memory; export a backup to keep them.`, storageKind: 'none' });
    }
    channel?.addEventListener('message', (e) => {
      const { project } = get();
      if (e.data?.type === 'takeover' && project && e.data.projectId === project.id && e.data.writerId !== get().store?.writerId) {
        autosave?.markReadOnly('Another tab took over editing of this project.');
        set({ readOnly: 'Another tab took over editing of this project. This tab is now read-only.' });
      }
      if (e.data?.type === 'committed') void get().refreshProjects();
    });
  },

  async refreshPlugins() {
    const h = get().pluginHost; if (!h) return;
    set({ installedPlugins: await h.list() });
  },

  async refreshProjects() {
    const s = get().store; if (!s) return;
    set({ projects: await s.listProjects() });
  },

  async newProject(title = 'Untitled song') {
    const store = get().store;
    const p = createEmptyProject({ title });
    if (!store) { attachSession(p, null, set, get); return; }
    await get().closeProject();
    await acquireWebLock(p.id, false, get, set); // lease 보다 먼저 lock: lease 보유자는 항상 lock 도 보유
    const lease = await store.acquireLease(p.id);
    if (!lease.ok) { releaseWebLock(); return get().toast('error', lease.errors[0].message); }
    const r = await store.commit(p, null, 0);
    if (!r.ok) { releaseWebLock(); return get().toast('error', `${r.errors[0].code}: ${r.errors[0].message}`); }
    attachSession(p, r.value.id, set, get);
    await get().refreshProjects();
  },

  async openProject(id, opts = {}) {
    const store = get().store; if (!store) return;
    await get().closeProject();
    // 04 §3 다중 탭. 탭 종료 판정은 응답 지연(lease 만료)이 아니라 종료 증거로만 한다:
    //  - Web Locks: exclusive lock 을 먼저 시도. 얻으면 이전 보유 탭은 닫혔다(lock 은 context 종료 시에만 풀림) → lease takeover.
    //    lock 이 다른 탭에 있으면 lease 가 만료됐어도(throttling) read-only. 명시적 takeover 는 lock 을 steal 한다.
    //  - Web Locks 없음: IDB lease + epoch fencing. 유효/만료 lease 모두 사용자의 명시적 takeover 가 필요하다.
    // 어느 경로든 takeover 후 이전 탭의 write 는 epoch/head 검사로 거절된다.
    const lock = await acquireWebLock(id, !!opts.takeover, get, set);
    const lease = await store.acquireLease(id, { takeover: !!opts.takeover || lock === 'held' });
    let readOnly: string | null = null;
    if (!lease.ok) {
      releaseWebLock();
      readOnly = lease.errors[0].code === 'WRITER_UNRESPONSIVE'
        ? 'The tab editing this project is not responding (it may be in the background). Opened read-only — use "Take over" to edit here.'
        : 'Another tab is editing this project. Opened read-only — use "Take over" to edit here.';
    } else if (opts.takeover) channel?.postMessage({ type: 'takeover', projectId: id, writerId: store.writerId });
    const o = await store.open(id);
    if (!o.ok) {
      const code = o.errors[0].code;
      set({ view: 'home' });
      if (lease.ok) { await store.releaseLease(id); releaseWebLock(); }
      if (code === 'FUTURE_VERSION') return get().toast('error', 'This project was saved by a newer version. It is kept unchanged (read-only); update the app to open it.');
      return get().toast('error', `${code}: ${o.errors[0].message}`);
    }
    attachSession(o.value.project, o.value.revision.id, set, get, o.value.revision.editSequence);
    set({ missing: o.value.missing, openDiagnostics: o.value.diagnostics, readOnly, saveStatus: o.value.missing.length ? 'degraded' : 'clean' });
    if (readOnly) autosave?.markReadOnly(readOnly);
    if (o.value.missing.length) get().toast('warn', `${o.value.missing.length} asset(s) are missing — the project opened in degraded mode. Originals are not deleted.`);
  },

  async closeProject() {
    const { store, project } = get();
    if (autosave) { await autosave.flush(); autosave.dispose(); autosave = null; }
    if (heartbeat) clearInterval(heartbeat); heartbeat = null;
    unsub?.(); unsub = null;
    if (store && project && store.hasLease(project.id)) await store.releaseLease(project.id);
    releaseWebLock(); // lease 를 먼저 놓은 뒤 lock 해제(다른 탭이 lock 을 얻으면 lease 는 이미 released)
    if (engine.state === 'playing') await engine.stop();
    set({ session: null, project: null, selection: { trackId: null, clipId: null, noteIds: [] }, readOnly: null, missing: [] });
  },

  run(label, c) {
    const s = get().session; if (!s) return false;
    if (get().readOnly) { get().toast('warn', 'Read-only: take over to edit.'); return false; }
    const r = s.run(label, c);
    if (!r.ok) { get().toast('error', `${r.errors[0].code}: ${r.errors[0].message}`); return false; }
    for (const d of r.value.diagnostics) if (!d.startsWith('COPY_ON_WRITE')) get().toast('info', d);
    return true;
  },
  undo() { const s = get().session; if (s && !get().readOnly) s.undo(); },
  redo() { const s = get().session; if (s && !get().readOnly) s.redo(); },
  async saveNow() { await autosave?.flush(); },
  select(sel) { set({ selection: { ...get().selection, ...sel } }); },
  toast(kind, text) {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 8000 : 4000);
  },

  async addInstrumentTrack(kind, instrument) {
    const { session, store } = get();
    if (!session) return;
    const trackId = uuid();
    if (!get().run('Add track', { type: 'CreateTrack', kind, instrument, trackId, withClip: kind !== 'audio' })) return;
    if (kind === 'audio' || !store) return;
    // 내장 샘플러에 자체 합성 키트 연결
    const kit: KitName = kind === 'drum' ? 'drums' : kind === 'midi' ? 'keys' : instrument === 'guitar' ? 'guitar' : 'bass';
    const t = get().project!.tracks.find((x) => x.id === trackId)!;
    const assets = await kitAssets(store, kit, get().project!);
    const samples = synthKit(kit);
    const assetOf = new Map(assets.map((a, i) => [samples[i].key, a]));
    const drumSrc = kind === 'drum' ? get().project!.sources.find((s) => s.id === t.clips[0]?.sourceId) : undefined;
    const pads = drumSrc?.kind === 'drum' ? drumSrc.pads : [];
    const state = {
      version: 1,
      zones: samples.filter((s) => s.role === 'zone').map((s) => ({ id: `${kit}-${s.articulation}-${s.rootPitch}`, assetId: assetOf.get(s.key)!.id, rootPitch: s.rootPitch, minPitch: s.minPitch, maxPitch: s.maxPitch, minVelocity: 1, maxVelocity: 127, articulation: s.articulation, loopStartFrame: null, loopEndFrame: null })),
      pads: samples.filter((s) => s.role === 'pad').flatMap((s) => pads.filter((p) => p.midiPitch === s.rootPitch).map((p) => ({ padId: p.id, assetId: assetOf.get(s.key)!.id, gain: 1, chokeGroup: p.chokeGroup }))),
      attackMs: 2, releaseMs: 120,
    };
    const newAssets = assets.filter((a) => !get().project!.assets.some((x) => x.id === a.id));
    const cmds: CommandPayload[] = [...newAssets.map((a) => ({ type: 'AddAsset' as const, asset: a })), { type: 'SetPluginState', instanceId: t.instrumentSlot!, state: state as never, assets: assets.map((a) => a.id) }];
    // Undo 한 번으로 트랙 추가를 되돌릴 수 있도록 kit 연결은 별도 명령(복합)
    get().run('Load instrument kit', { type: 'Batch', commands: cmds });
  },

  async saveProjectFile(options = {}) {
    const initial = get();
    if (!initial.project || initial.fileBusy) return;
    const projectId = initial.project.id;
    const previousState = initial.fileState;
    set({ fileBusy: true });
    try {
      // Picker must run before asynchronous archive construction to retain user activation.
      let handle = options.download ? null : !options.saveAs ? initial.fileHandle : null;
      // Legacy files stay untouched; Save As migrates to a separate .dawbae file.
      if (handle && !handle.name.toLowerCase().endsWith('.dawbae')) handle = null;
      if (!options.download && !handle) handle = await pickSaveFile(window as unknown as ProjectFilePicker, projectFileName(initial.project.title));
      if (handle && !handle.name.toLowerCase().endsWith('.dawbae')) throw new Error('Use the .dawbae file extension.');
      if (get().project?.id !== projectId) return;
      set({ fileState: 'saving', fileError: null });
      const { project, editSeq, store } = get();
      if (!project) return;
      const result = await createProjectArchive(project, h => store?.readAsset(h) ?? Promise.resolve(null), { localFile: true });
      if (!result.ok) throw new Error(`${result.errors[0].code}: ${result.errors[0].message}`);
      if (handle) await writeProjectFile(handle, result.value.blob);
      else download(result.value.blob, projectFileName(project.title));
      if (get().project?.id === projectId) set({
        fileHandle: handle, fileName: handle?.name ?? projectFileName(project.title), fileSavedSeq: editSeq,
        fileState: handle ? 'saved' : 'downloaded', fileError: null,
      });
      get().toast('info', handle ? '.dawbae 파일 저장 완료' : '.dawbae 다운로드 요청 완료. 브라우저의 다운로드 완료를 확인하세요.');
    } catch (e) {
      if (get().project?.id === projectId) {
        if (isFileCancelled(e)) set({ fileState: previousState });
        else { set({ fileState: 'error', fileError: (e as Error).message }); get().toast('error', `파일 저장 실패: ${(e as Error).message}`); }
      }
    } finally { set({ fileBusy: false }); }
  },

  async exportBackup() { await get().saveProjectFile({ download: true }); },

  async openProjectFile(file, handle) {
    const store = get().store;
    if (!store) return get().toast('error', 'Local recovery storage is not ready.');
    const r = await importArchive(store, file);
    if (!r.ok) return get().toast('error', `Import refused — ${r.errors[0].code}: ${r.errors[0].message}. Existing projects are unchanged.`);
    await store.releaseLease(r.value.projectId);
    await get().refreshProjects();
    await get().openProject(r.value.projectId);
    if (get().project?.id === r.value.projectId) set({ fileHandle: handle ?? null, fileName: file.name, fileSavedSeq: get().editSeq, fileState: r.value.missing.length ? 'error' : 'saved', fileError: r.value.missing.length ? 'Original assets missing' : null });
    if (r.value.missing.length) get().toast('warn', `${r.value.missing.length} original asset(s) missing. File saving is blocked until assets are restored.`);
  },

  async importBackup(file) {
    const store = get().store;
    if (!store) return get().toast('error', 'Local storage is not ready; import needs local storage.');
    const r = await importArchive(store, file);
    if (!r.ok) return get().toast('error', `Import refused — ${r.errors[0].code}: ${r.errors[0].message}. Existing projects are unchanged.`);
    await store.releaseLease(r.value.projectId);
    await get().refreshProjects();
    get().toast('info', `Imported as a new copy${r.value.missing.length ? ` (${r.value.missing.length} external asset(s) missing)` : ''}.`);
  },
}));

/**
 * project 별 exclusive Web Lock. 'held' 면 이 탭이 쥐고 있다(탭 종료 시 브라우저가 해제 → 다른 탭이 종료 증거로 사용).
 * steal=true(사용자의 명시적 takeover)면 기존 보유 탭의 lock 을 빼앗고, 그 탭은 AbortError 로 즉시 read-only 가 된다.
 */
let lockSeq = 0;
function acquireWebLock(id: string, steal: boolean, get: () => AppState, set: (p: Partial<AppState>) => void): Promise<'held' | 'busy' | 'unsupported'> {
  if (!('locks' in navigator)) return Promise.resolve('unsupported');
  releaseWebLock();
  const mine = ++lockSeq;
  return new Promise((resolve) => {
    navigator.locks.request(`bass-daw:${id}`, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
      if (!lock) { resolve('busy'); return undefined; }
      resolve('held');
      return new Promise<void>((res) => { lockRelease = res; });
    }).catch((e: DOMException) => {
      // 다른 탭이 steal → 이 탭은 더 이상 writer 가 아니다(다음 commit 도 epoch 로 거절됨)
      if (e?.name === 'AbortError' && mine === lockSeq && get().project?.id === id && !get().readOnly) {
        lockRelease = null;
        autosave?.markReadOnly('Another tab took over editing of this project.');
        set({ readOnly: 'Another tab took over editing of this project. This tab is now read-only.' });
      }
      resolve('busy');
    });
  });
}
function releaseWebLock() { lockRelease?.(); lockRelease = null; }

function attachSession(p: Project, head: string | null, set: (p: Partial<AppState>) => void, get: () => AppState, seq = 0) {
  const session = new ProjectSession(p, seq);
  const store = get().store;
  autosave?.dispose();
  autosave = store ? new AutosaveController({
    commit: (proj, expected, s) => store.commit(proj, expected, s),
    clearCaches: () => store.clearCaches(),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as number), now: () => Date.now(),
  }, head, seq) : null;
  autosave?.subscribe((a) => {
    set({ saveStatus: a.status, saveError: a.lastError });
    if (a.status === 'saved') { channel?.postMessage({ type: 'committed', projectId: p.id }); void get().refreshProjects(); for (const l of commitListeners) l(p.id); }
    if (a.status === 'read-only') set({ readOnly: a.lastError ?? 'read-only' });
  });
  unsub = session.subscribe((s) => {
    set({ project: s.project, editSeq: s.editSequence });
    autosave?.notify(s.project, s.editSequence);
    if (!store) set({ saveStatus: 'dirty' });
  });
  if (store) heartbeat = setInterval(async () => {
    if (!get().project || get().readOnly) return;
    const r = await store.heartbeat(p.id);
    if (!r.ok) { autosave?.markReadOnly('Writer lease lost (another tab took over or this tab was throttled).'); set({ readOnly: 'Writer lease lost — this tab is now read-only. Re-open to edit.' }); }
  }, HEARTBEAT_MS);
  set({ fileHandle: null, fileName: null, fileSavedSeq: null, fileState: 'unsaved', fileError: null, session, project: p, editSeq: seq, view: 'editor', saveStatus: store ? 'clean' : 'dirty', saveError: store ? null : get().storageError });
}

async function kitAssets(store: LocalStore, kit: KitName, p: Project): Promise<Asset[]> {
  const samples = synthKit(kit);
  const out: Asset[] = [];
  for (const s of samples) {
    const r = await store.importAsset(s.bytes);
    if (!r.ok) throw new Error(r.errors[0].message);
    const existing = p.assets.find((a) => a.sha256 === r.value.hash);
    const frames = (s.bytes.length - 44) / 2;
    out.push(existing ?? { id: uuid(), sha256: r.value.hash, byteLength: r.value.bytes, mediaType: 'audio/wav', audio: { sampleRate: KIT_SAMPLE_RATE, channels: 1, frameCount: frames }, license: { ...KIT_LICENSE } });
  }
  return out;
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function safe(s: string) { return s.replace(/[^\w\- ]+/g, '_').trim() || 'project'; }
export { nowIso };
