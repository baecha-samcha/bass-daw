import { useEffect, lazy, Suspense } from 'react';
import { useApp } from '../store.ts';
import { useCloud, syncLabel, FAKE_AUTH_UI, API_BASE } from '../sync/cloud.ts';

// 개발 전용 로그인 폼: production 빌드에서는 null 로 접혀 모듈이 포함되지 않는다
const DevLogin = import.meta.env.MODE !== 'production' ? lazy(() => import('./DevLogin.tsx')) : null;

/** Home: 계정·클라우드 목록. 로그인 없이도 로컬 기능은 전부 동작한다. */
export function CloudCard() {
  const { enabled, session, remote, busy } = useCloud();
  const projects = useApp((s) => s.projects);
  useEffect(() => { if (session) void useCloud.getState().refreshRemote(); }, [session?.ownerId]);
  if (!enabled) return <div className="card dim" data-testid="cloud-card">클라우드 동기화: 비활성 — 로그인 공급자·도메인이 아직 정해지지 않았습니다(D07). 이 기기의 로컬 저장·백업은 그대로 동작합니다.</div>;
  const local = new Set(projects.map((p) => p.projectId));
  const onlyRemote = remote.filter((r) => !local.has(r.id) && !r.tombstoned);
  return (
    <div className="card col" data-testid="cloud-card">
      <h2>클라우드 동기화</h2>
      {!session ? (
        FAKE_AUTH_UI && DevLogin ? (
          <Suspense fallback={null}><DevLogin /></Suspense>
        ) : <div className="dim">로그인 공급자가 설정되지 않았습니다(D07). API: {API_BASE}</div>
      ) : (
        <>
          <div className="row">
            <span>로그인: <b data-testid="cloud-owner">{session.ownerId}</b> <span className="dim">만료 {new Date(session.expiresAt).toLocaleTimeString()}</span></span>
            <button onClick={() => useCloud.getState().syncNow()}>지금 동기화</button>
            <button onClick={() => useCloud.getState().refreshRemote()}>목록 새로고침</button>
            <button onClick={() => useCloud.getState().logout()}>로그아웃</button>
            <span className="dim">로그아웃해도 이 기기의 프로젝트는 지워지지 않습니다. 로컬 프로젝트는 "클라우드 연결"을 눌러야 올라갑니다.</span>
          </div>
          {onlyRemote.length > 0 && (
            <table aria-label="클라우드 프로젝트"><tbody>{onlyRemote.map((r) => (
              <tr key={r.id} data-testid={`remote-${r.id}`}><td className="mono">{r.id.slice(0, 8)}… <span className="dim">갱신 {r.updatedAt.replace('T', ' ').slice(0, 19)}</span></td>
                <td><button disabled={!!busy} onClick={() => useCloud.getState().clone(r.id)} aria-label={`클라우드 ${r.id} 이 기기로 복원`}>이 기기로 복원</button></td></tr>
            ))}</tbody></table>
          )}
        </>
      )}
    </div>
  );
}

/** Home 프로젝트 행의 동기화 표시·버튼 */
export function ProjectSyncCell({ projectId, title }: { projectId: string; title: string }) {
  const { enabled, session, statuses } = useCloud();
  const rec = useApp((s) => s.projects.find((p) => p.projectId === projectId));
  if (!enabled) return null;
  const st = statuses[projectId];
  const linked = !!rec?.sync;
  return (
    <span className="row">
      <span className={`status-pill sync-${st?.state ?? 'local-only'}`} data-testid={`sync-${projectId}`}>{linked ? syncLabel(st) : '로컬 전용'}</span>
      {session && !linked && <button className="small" onClick={() => useCloud.getState().link(projectId)} aria-label={`${title} 클라우드 연결`}>클라우드 연결</button>}
    </span>
  );
}

/** 편집기 상단의 동기화 칩 */
export function SyncChip() {
  const { enabled, statuses } = useCloud();
  const project = useApp((s) => s.project);
  if (!enabled || !project) return null;
  const st = statuses[project.id];
  return <button className={`status-pill sync-${st?.state ?? 'local-only'}`} data-testid="sync-status" title={st?.error ?? ''} onClick={() => useApp.getState().set({ panel: 'sync' })}>{syncLabel(st)}</button>;
}

/** 편집기 '동기화' 탭: 상태, 연결, 충돌 해결(사용자 선택만), 보존된 분기 */
export function SyncPanel() {
  const { enabled, session, statuses, conflict, branches, busy } = useCloud();
  const project = useApp((s) => s.project);
  const rec = useApp((s) => s.projects.find((p) => p.projectId === s.project?.id));
  const id = project?.id;
  useEffect(() => { if (id) void useCloud.getState().loadConflict(id); }, [id, statuses[id ?? '']?.state]);
  if (!project || !id) return null;
  if (!enabled) return <div className="dim">클라우드 동기화가 비활성입니다(D07 미정). 로컬 저장은 정상 동작합니다.</div>;
  const st = statuses[id];
  const c = useCloud.getState().act;
  return (
    <div className="col">
      <div className="card col">
        <div className="row"><b>동기화 상태:</b> <span data-testid="sync-detail">{rec?.sync ? syncLabel(st) : '로컬 전용'}</span>
          {st?.pendingBytes ? <span className="dim">남은 {(st.pendingBytes / 1024).toFixed(0)} KiB</span> : null}
          {st?.error && <span className="err">{st.error}</span>}</div>
        <div className="dim mono">local head {rec?.head?.slice(0, 8) ?? '-'} · remote head {rec?.remoteHead?.slice(0, 8) ?? '-'} · 계정 {rec?.sync?.ownerId ?? '-'}</div>
        <div className="dim">로컬 저장 성공(“저장됨”)과 클라우드 동기화 성공(“동기화됨”)은 별개입니다.</div>
        <div className="row">
          {!session && <span className="warn">로그인하면 동기화됩니다(홈 화면).</span>}
          {session && !rec?.sync && <button onClick={() => useCloud.getState().link(id)}>클라우드 연결(최초 업로드)</button>}
          {session && rec?.sync && <button onClick={() => useCloud.getState().syncNow()} disabled={!!busy}>지금 동기화</button>}
          {session && rec?.sync && rec.remoteHead && !conflict && <button onClick={() => { if (confirm('클라우드 사본을 삭제할까요? 30일 보존(tombstone)되며 이 기기의 로컬 프로젝트는 그대로 남습니다.')) void c('클라우드 사본 삭제', (e) => e.deleteRemote(id)); }}>클라우드 사본 삭제</button>}
          {rec?.sync && <button onClick={() => void c('연결 해제', async (e) => { await e.unlink(id); return { ok: true }; })}>연결 해제(로컬 유지)</button>}
          {busy && <span className="warn">{busy}…</span>}
        </div>
        {st?.remoteDeleted && !conflict && (
          <div className="row warn" data-testid="remote-deleted">이 프로젝트는 다른 기기에서 클라우드 삭제되었습니다. 이 기기 사본은 보존됩니다.
            <button onClick={() => void c('클라우드 복원', (e) => e.restoreRemoteWithLocal(id))}>클라우드 복원</button></div>
        )}
      </div>
      {conflict && (
        <div className="card col" role="group" aria-label="동기화 충돌" data-testid="conflict">
          <h2>동기화 충돌 — 두 작업이 모두 보존되어 있습니다</h2>
          <div className="dim">자동으로 덮어쓰거나 병합하지 않습니다. 아래에서 직접 선택하세요. 어떤 선택도 로컬 분기를 삭제하지 않습니다.</div>
          {conflict.remoteDeleted ? (
            <>
              <div className="warn">다른 기기에서 클라우드 사본을 삭제했지만 이 기기에 오프라인 편집이 있습니다. 로컬은 자동 삭제되지 않습니다.</div>
              <div className="row">
                <button className="primary" disabled={!!busy} onClick={() => void c('내 버전으로 클라우드 복원', (e) => e.restoreRemoteWithLocal(id))}>내 버전으로 클라우드 복원</button>
                <button disabled={!!busy} onClick={() => void c('로컬 전용으로 유지', async (e) => { await e.unlink(id); return { ok: true }; })}>로컬 전용으로 유지(연결 해제)</button>
              </div>
            </>
          ) : (
            <>
              <table className="compare"><thead><tr><th></th><th>이 기기(로컬)</th><th>클라우드(원격)</th></tr></thead><tbody>
                <tr><td>제목</td><td data-testid="cmp-local-title">{conflict.local?.title}</td><td data-testid="cmp-remote-title">{conflict.remote?.title ?? '…'}</td></tr>
                <tr><td>트랙</td><td>{conflict.local?.tracks.join(', ')}</td><td>{conflict.remote?.tracks.join(', ')}</td></tr>
                <tr><td>BPM</td><td>{conflict.local?.bpm}</td><td>{conflict.remote?.bpm}</td></tr>
                <tr><td>수정</td><td className="mono">{conflict.local?.updatedAt.slice(0, 19)}</td><td className="mono">{conflict.remote?.updatedAt.slice(0, 19)}</td></tr>
                <tr><td>revision</td><td className="mono">{conflict.local?.revision.slice(0, 8)}</td><td className="mono">{conflict.remoteHead?.slice(0, 8)}</td></tr>
              </tbody></table>
              <div className="row">
                <button disabled={!!busy} onClick={() => void c('로컬을 새 프로젝트로 보관', (e) => e.keepLocalAsNewProject(id))}>로컬을 새 프로젝트로 보관</button>
                <button className="primary" disabled={!!busy} onClick={() => void c('원격 사본 열기', (e) => e.openRemote(id))}>원격 사본 열기</button>
                <button disabled={!!busy} onClick={() => void c('비교용 원격 사본 만들기', (e) => e.remoteCopyForCompare(id))}>비교용 원격 사본 만들기</button>
                <button disabled={!!busy} onClick={async () => { await useApp.getState().saveNow(); if (confirm('이 프로젝트의 현재 내용(수동 병합 결과)을 원격 최신본 위에 올릴까요? 원격 revision 은 이력에 남습니다.')) void c('수동 병합 결과 올리기', (e) => e.resolveManually(id)); }}>수동 병합 완료 — 원격 위로 올리기</button>
              </div>
              <div className="dim">“원격 사본 열기”: 이 프로젝트를 클라우드 최신본으로 바꾸고, 로컬 작업은 아래 “보존된 분기”에 남깁니다. “비교용 원격 사본”: 원격본을 별도 로컬 프로젝트로 만들어 나란히 비교한 뒤 직접 병합할 수 있습니다.</div>
            </>
          )}
        </div>
      )}
      {branches.length > 0 && (
        <div className="card col" data-testid="branches">
          <h2>보존된 분기</h2>
          <table><tbody>{branches.map((b) => (
            <tr key={b.revisionId}><td className="mono">{b.revisionId.slice(0, 8)} · {b.reason} · {b.at.slice(0, 19)}{b.note ? ` · ${b.note}` : ''}</td>
              <td><button className="small" onClick={() => void c('분기를 새 프로젝트로 열기', (e) => e.branchToNewProject(id, b.revisionId, `${project.title} (분기 ${b.revisionId.slice(0, 6)})`))}>새 프로젝트로 열기</button></td></tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  );
}
