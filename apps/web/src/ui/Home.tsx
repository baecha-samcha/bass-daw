import { useRef, useState } from 'react';
import { useApp } from '../store.ts';
import { PROJECT_ACCEPT, type ProjectFilePicker } from '../files/project-file.ts';

export function Home() {
  const { projects, storageKind, storageError, persisted, store } = useApp();
  const [title, setTitle] = useState('New song');
  const file = useRef<HTMLInputElement>(null);
  const [recovering, setRecovering] = useState<{ id: string; revs: { id: string; createdAt: string; valid: boolean; editSequence: number }[] } | null>(null);

  const openFile = async () => {
    const picker = window as unknown as ProjectFilePicker;
    if (!picker.showOpenFilePicker) { file.current?.click(); return; }
    try {
      const [handle] = await picker.showOpenFilePicker({ multiple: false, types: [{ description: 'DAW Bae project', accept: { 'application/zip': ['.dawbae', '.bassdaw'] } }] });
      if (handle) await useApp.getState().openProjectFile(await handle.getFile(), handle);
    } catch (e) { if ((e as Error).name !== 'AbortError') useApp.getState().toast('error', `파일 열기 실패: ${(e as Error).message}`); }
  };

  const open = async (id: string, takeover = false) => {
    await useApp.getState().openProject(id, { takeover });
    if (useApp.getState().view !== 'editor' && store) {
      const r = await store.recover(id);
      if (r.ok) setRecovering({ id, revs: r.value });
    }
  };

  return (
    <div className="page col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Bass TAB DAW</h1>
        <span className="row"><a href="#/score-check" className="dim">악보 출력 검증</a><a href="#/diagnostics" className="dim">환경 진단(MVP-0)</a></span>
      </div>
      <div className="card col">
        <div className="row">
          <span>저장소: <b>{storageKind === 'opfs' ? 'OPFS + IndexedDB' : storageKind === 'idb' ? 'IndexedDB (OPFS 불가 fallback)' : '없음'}</b></span>
          <span className="dim">persist: {persisted === null ? '미확인' : persisted ? '허가됨' : '거부(브라우저가 정리할 수 있음)'}</span>
        </div>
        {storageError && <div className="err">{storageError}</div>}
        <div className="dim">로그인 없이 .dawbae 파일로 저장하고 열 수 있습니다. 브라우저 자동 저장은 복구용 사본이며 파일 저장과 별개입니다.</div>
      </div>
      <div className="card row">
        <label className="row">제목 <input aria-label="새 프로젝트 제목" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <button className="primary" disabled={!store && !storageError} onClick={() => useApp.getState().newProject(title)}>새 프로젝트</button>
        <button onClick={()=>void openFile()} disabled={!store}>파일 열기 (.dawbae)</button>
        <input ref={file} type="file" accept={PROJECT_ACCEPT} disabled={!store} aria-label="프로젝트 파일 열기" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void useApp.getState().openProjectFile(f); e.target.value = ''; }} />
      </div>
      <div className="card">
        <h2>이 기기의 복구용 프로젝트</h2>
        {projects.length === 0 && <div className="dim">아직 프로젝트가 없습니다.</div>}
        <table>
          <tbody>
            {projects.map((p) => (
              <tr key={p.projectId}>
                <td><b>{p.title}</b><div className="dim mono">{p.updatedAt.replace('T', ' ').slice(0, 19)}</div></td>
                
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button onClick={() => open(p.projectId)} aria-label={`${p.title} 열기`}>열기</button>
                  <button onClick={() => open(p.projectId, true)} title="다른 탭이 편집 중이어도 이 탭에서 편집 권한을 가져옵니다">가져와 편집</button>
                  <button onClick={async () => { if (!store) return; const r = await store.recover(p.projectId); if (r.ok) setRecovering({ id: p.projectId, revs: r.value }); }}>버전</button>
                  <button onClick={async () => { if (confirm(`"${p.title}" 프로젝트를 이 기기 목록에서 삭제할까요? (원본 데이터는 7일 유예 후 정리, .dawbae 파일은 삭제하지 않음)`)) { await store?.deleteProject(p.projectId); await useApp.getState().refreshProjects(); } }}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {recovering && (
        <div className="card col" role="dialog" aria-label="복구">
          <h2>저장된 버전 / 복구</h2>
          <div className="dim">손상된 snapshot 은 덮어쓰지 않습니다. 정상 버전을 새 head 로 복원할 수 있습니다.</div>
          <table><tbody>
            {recovering.revs.slice(0, 30).map((r) => (
              <tr key={r.id}><td className="mono">{r.createdAt.replace('T', ' ').slice(0, 19)} · seq {r.editSequence}</td><td>{r.valid ? <span className="ok">정상</span> : <span className="err">손상</span>}</td>
                <td>{r.valid && <button className="small" onClick={async () => { await store!.acquireLease(recovering.id, { takeover: true }); const x = await store!.restoreRevision(recovering.id, r.id); if (x.ok) { setRecovering(null); await open(recovering.id); } else useApp.getState().toast('error', x.errors[0].message); }}>이 버전으로 복원</button>}</td></tr>
            ))}
          </tbody></table>
          <button onClick={() => setRecovering(null)}>닫기</button>
        </div>
      )}
    </div>
  );
}
