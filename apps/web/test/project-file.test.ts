import {it,expect,vi} from 'vitest';
import {projectFileName,pickSaveFile,writeProjectFile,isFileCancelled,type ProjectFileHandle} from '../src/files/project-file.ts';
it('names local project files, preserving Korean titles and filtering path/control characters',()=>{
 expect(projectFileName('내 노래')).toBe('내 노래.dawbae');expect(projectFileName('../bad/name')).toBe('.._bad_name.dawbae');expect(projectFileName('')).toBe('project.dawbae');
});
it('unsupported picker requests download; a cancelled picker is never retried as download',async()=>{
 expect(await pickSaveFile({},'a.dawbae')).toBeNull();
 const error=new DOMException('cancelled','AbortError');
 await expect(pickSaveFile({showSaveFilePicker:async()=>{throw error;}},'a.dawbae')).rejects.toBe(error);expect(isFileCancelled(error)).toBe(true);
});
it.each(['write','close'])('failed %s aborts instead of reporting success',async(failure)=>{
 const error=Error('disk full'),stream={write:vi.fn(async()=>{}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
 stream[failure as 'write'|'close'].mockRejectedValueOnce(error);
 const handle={name:'song.dawbae',getFile:vi.fn(),createWritable:async()=>stream} as ProjectFileHandle;
 await expect(writeProjectFile(handle,new Blob(['test']))).rejects.toBe(error);expect(stream.abort).toHaveBeenCalledOnce();
});
