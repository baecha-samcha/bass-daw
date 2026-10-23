import { useApp } from '../store.ts';

export function projectFileStatus(s: Pick<ReturnType<typeof useApp.getState>, 'fileState' | 'fileSavedSeq' | 'editSeq'>) {
  if (s.fileState === 'saving') return '파일 저장 중…';
  if (s.fileState === 'error') return '파일 저장 실패';
  if (s.fileSavedSeq === null || s.fileSavedSeq !== s.editSeq) return '파일 미저장';
  return s.fileState === 'downloaded' ? '파일 다운로드 요청됨' : '파일 저장됨';
}
export function ProjectFilesPanel() {
  const s = useApp();
  return <div className="col">
    <h2>로컬 프로젝트 파일 (.dawbae)</h2>
    <div role="status" data-testid="file-detail">{projectFileStatus(s)}{s.fileName ? ` · ${s.fileName}` : ''}</div>
    <div className="row">
      <button disabled={s.fileBusy} onClick={()=>void s.saveProjectFile()}>이 파일에 저장</button>
      <button disabled={s.fileBusy} onClick={()=>void s.saveProjectFile({saveAs:true})}>다른 이름으로 저장</button>
      <button disabled={s.fileBusy} onClick={()=>void s.exportBackup()}>파일 내려받기</button>
    </div>
    <p>프로젝트·원본 음원·녹음을 하나의 .dawbae 파일로 저장합니다. 파일을 다른 기기로 옮긴 뒤 홈에서 열면 계속 편집할 수 있습니다.</p>
    <p>클라우드 업로드나 로그인은 사용하지 않습니다. 브라우저 자동 저장은 장애 복구용 사본이며, 컴퓨터의 프로젝트 파일 저장과 별개입니다.</p>
    <p>파일 직접 저장을 지원하는 브라우저에서는 선택한 파일에 저장합니다. 그 외에는 매번 다운로드하며 다운로드 완료 여부는 브라우저에서 확인하세요.</p>
    <p>개인 저장 파일에 포함된 음원·플러그인의 사용·공유 조건은 원래 라이선스를 따릅니다. 외부 플러그인 프로그램은 별도 설치가 필요할 수 있습니다.</p>
    {s.fileError && <div className="err" role="alert">{s.fileError}</div>}
  </div>;
}
