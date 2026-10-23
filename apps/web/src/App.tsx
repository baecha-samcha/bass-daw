import { useEffect } from 'react';
import { useApp } from './store.ts';
import { Home } from './ui/Home.tsx';
import { Editor } from './ui/Editor.tsx';
import { Diagnostics } from './diagnostics/Diagnostics.tsx';
import { ScoreCheck } from './ui/Score.tsx';
import { applyUpdate, canApplyUpdate } from './sw-client.ts';

export function App() {
  const view = useApp((s) => s.view);
  const toasts = useApp((s) => s.toasts);
  const updateReady = useApp((s) => s.updateReady);
  useEffect(() => {
    if (location.hash === '#/diagnostics') useApp.getState().set({ view: 'diagnostics' });
    if (location.hash === '#/score-check') useApp.getState().set({ view: 'score-check' });
    void useApp.getState().init();
    const onHash = () => useApp.getState().set({ view: location.hash === '#/diagnostics' ? 'diagnostics' : location.hash === '#/score-check' ? 'score-check' : useApp.getState().project ? 'editor' : 'home' });
    const warnUnsavedFile = (e: BeforeUnloadEvent) => {
      const s = useApp.getState();
      if (s.project && s.fileName && (s.fileBusy || s.fileSavedSeq !== s.editSeq)) { e.preventDefault(); e.returnValue = ''; }
    };
    addEventListener('hashchange', onHash);
    addEventListener('beforeunload', warnUnsavedFile);
    return () => { removeEventListener('hashchange', onHash); removeEventListener('beforeunload', warnUnsavedFile); };
  }, []);
  return (
    <>
      {updateReady && (
        <div className="banner" role="status">
          새 버전이 준비되었습니다.{' '}
          <button onClick={async () => { if (!(await applyUpdate())) useApp.getState().toast('warn', canApplyUpdate() ? 'Update not ready' : '재생/녹음을 멈춘 뒤 업데이트하세요.'); }}>업데이트 적용</button>
        </div>
      )}
      {view === 'home' && <Home />}
      {view === 'editor' && <Editor />}
      {view === 'diagnostics' && <Diagnostics />}
      {view === 'score-check' && <ScoreCheck />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </>
  );
}
