// 클라우드 동기화 UI 상태(Zustand). 도메인 로직은 @bass-daw/storage SyncEngine, 네트워크는 http-api.ts.
// - VITE_API_BASE 가 없으면(production 기본 빌드) 동기화 비활성: 로그인 공급자 미정(D07).
// - fake 로그인은 development/e2e 빌드 + localhost API 에서만 노출된다(서버도 development+localhost 에서만 허용).
import { create } from 'zustand';
import { SyncEngine, type SyncStatus, type RemoteProjectInfo, type ConflictRecord, type LocalBranch } from '@bass-daw/storage';
import type { Project } from '@bass-daw/schemas';
import { useApp, commitListeners } from '../store.ts';
import { engine as audio } from '../audio/engine.ts';
import { recorderBusy } from '../audio/recorder.ts';
import { httpRemoteApi } from './http-api.ts';
import { hashInWorker } from './hasher.ts';

export const API_BASE: string = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const isLocal = (u: string) => { try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; } };
// MODE 는 빌드 시 문자열로 치환된다 → production 에서는 상수 false 로 접혀 dev-auth 모듈이 번들에서 빠진다
export const FAKE_AUTH_UI = import.meta.env.MODE !== 'production' && !!API_BASE && isLocal(API_BASE);
const SESSION_KEY = 'bass-daw.fake-session';

interface Session { ownerId: string; token: string; expiresAt: number }
interface CloudState {
  enabled: boolean;
  session: Session | null;
  statuses: Record<string, SyncStatus>;
  remote: RemoteProjectInfo[];
  conflict: (ConflictRecord & { local?: Summary; remote?: Summary }) | null;
  branches: LocalBranch[];
  busy: string;
  engine: SyncEngine | null;
  init(): void;
  login(user: string): Promise<void>;
  logout(): void;
  link(id: string): Promise<void>;
  syncNow(): Promise<void>;
  refreshRemote(): Promise<void>;
  clone(id: string): Promise<void>;
  loadConflict(id: string): Promise<void>;
  act(label: string, f: (e: SyncEngine) => Promise<{ ok: boolean; errors?: { code: string; message: string }[]; value?: unknown }>): Promise<unknown>;
}
export interface Summary { title: string; tracks: string[]; bpm: number; updatedAt: string; revision: string }
const summarize = (p: Project, revision: string): Summary => ({ title: p.title, tracks: p.tracks.map((t) => t.name), bpm: p.tempoMap[0]?.bpm ?? 0, updatedAt: p.updatedAt, revision });

function loadSession(): Session | null {
  if (!FAKE_AUTH_UI) return null;
  try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null; return s && s.expiresAt > Date.now() ? s : null; } catch { return null; }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useCloud = create<CloudState>((set, get) => ({
  enabled: !!API_BASE, session: null, statuses: {}, remote: [], conflict: null, branches: [], busy: '', engine: null,

  init() {
    const store = useApp.getState().store;
    if (!API_BASE || !store || get().engine) return;
    const api = httpRemoteApi(API_BASE, () => get().session?.token ?? null);
    const e = new SyncEngine(store, api, {
      hasher: hashInWorker, // 업로드 해시는 전용 Worker(bounded streaming)
      isBusy: () => audio.state === 'playing' || recorderBusy(), // 재생/녹음 중 대형 업로드 일시 정지
      canReplaceLocal: (id) => { const a = useApp.getState(); return a.project?.id !== id || (['clean', 'saved'].includes(a.saveStatus) && !a.readOnly); },
      onLocalReplaced: (id) => { if (useApp.getState().project?.id === id) void useApp.getState().openProject(id); else void useApp.getState().refreshProjects(); },
      onChange: (id, s) => {
        set({ statuses: { ...get().statuses, [id]: s } });
        if (s.state === 'conflict' && useApp.getState().project?.id === id) void get().loadConflict(id);
      },
    });
    set({ engine: e });
    const s = loadSession();
    if (s) { set({ session: s }); e.setSession({ ownerId: s.ownerId }); }
    commitListeners.add(() => e.kick(300));
    addEventListener('online', () => e.kick());
    pollTimer ??= setInterval(() => void poll(), 15_000);
    void (async () => { for (const r of await store.listProjects()) if (r.sync) set({ statuses: { ...get().statuses, [r.projectId]: await e.status(r.projectId) } }); e.kick(); })();
  },

  async login(user) {
    if (import.meta.env.MODE === 'production' || !FAKE_AUTH_UI) return useApp.getState().toast('error', '로그인 공급자가 설정되지 않았습니다(D07).');
    try {
      const { fakeLogin } = await import('./dev-auth.ts');
      const l = await fakeLogin(API_BASE, user);
      const s = { ownerId: l.ownerId, token: l.token, expiresAt: l.expiresAt };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* 저장 불가 시 이 탭에서만 */ }
      set({ session: s });
      get().engine?.setSession({ ownerId: s.ownerId });
      get().engine?.kick();
      await get().refreshRemote();
    } catch (e) { useApp.getState().toast('error', `로그인 실패: ${(e as Error).message}`); }
  },

  logout() {
    // 클라우드 세션만 종료. 로컬 프로젝트·대기 outbox 는 지우지 않는다.
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    set({ session: null, remote: [] });
    get().engine?.setSession(null);
  },

  async link(id) { await get().act('클라우드 연결', (e) => e.link(id)); },
  async syncNow() { const e = get().engine; if (!e) return; await useApp.getState().saveNow(); await e.syncAll({ force: true }); const id = useApp.getState().project?.id; if (id && get().session) await e.pull(id).catch(() => undefined); },
  async refreshRemote() {
    const e = get().engine; if (!e || !get().session) return;
    try { set({ remote: await e.remoteProjects() }); } catch (x) { useApp.getState().toast('warn', `클라우드 목록을 가져오지 못했습니다: ${(x as Error).message}`); }
  },
  async clone(id) {
    await get().act('이 기기로 복원', (e) => e.clone(id));
    await useApp.getState().refreshProjects();
  },
  async loadConflict(id) {
    const e = get().engine; const store = useApp.getState().store; if (!e || !store) return;
    const c = await store.conflict(id);
    set({ branches: await store.branches(id) });
    if (!c) { set({ conflict: null }); return; }
    set({ conflict: c });
    const rec = await store.getRecord(id);
    const o = rec?.head ? await store.open(id) : null;
    const local = o?.ok ? summarize(o.value.project, o.value.revision.id) : undefined;
    let remote: Summary | undefined;
    if (c.remoteHead && !c.remoteDeleted && get().session) { const r = await e.peekRemote(id, c.remoteHead).catch(() => null); if (r?.ok) remote = summarize(r.value, c.remoteHead); }
    set({ conflict: { ...c, local, remote } });
  },
  async act(label, f) {
    const e = get().engine; if (!e) return;
    set({ busy: label });
    try {
      const r = await f(e);
      if (!r.ok) useApp.getState().toast('error', `${label} 실패 — ${r.errors?.[0].code}: ${r.errors?.[0].message}`);
      else useApp.getState().toast('info', `${label} 완료`);
      const id = useApp.getState().project?.id; if (id) await get().loadConflict(id);
      await useApp.getState().refreshProjects();
      return r.value;
    } catch (x) { useApp.getState().toast('error', `${label} 실패 — ${(x as Error).message}`); }
    finally { set({ busy: '' }); }
  },
}));

async function poll() {
  const { engine: e, session } = useCloud.getState();
  if (!e || !session || !navigator.onLine) return;
  if (session.expiresAt < Date.now()) { e.setSession(null); useCloud.setState({ session: null }); return; }
  const id = useApp.getState().project?.id;
  if (id) await e.pull(id).catch(() => undefined);
  e.kick();
}

export function syncLabel(s?: SyncStatus): string {
  if (!s) return '로컬 전용';
  if (s.remoteDeleted && s.state !== 'conflict') return '클라우드에서 삭제됨';
  return ({ 'local-only': '로컬 전용', idle: '대기', queued: '동기화 대기', uploading: '업로드 중', committing: '커밋 중', synced: '동기화됨', conflict: '충돌', 'auth-required': '로그인 필요', offline: '오프라인', error: '동기화 오류' } as Record<string, string>)[s.state] ?? s.state;
}
