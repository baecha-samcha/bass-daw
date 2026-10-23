import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,readFileSync} from 'node:fs';
import {BASE,newProject} from './helpers.ts';
const OUT='tests/artifacts/local-files';mkdirSync(OUT,{recursive:true});
const state=(page:Page)=>page.evaluate(()=>{const s=(window as any).__bassdaw.state();return {project:s.project,plan:(window as any).__bassdaw.planHash(),seq:s.editSeq,fileSeq:s.fileSavedSeq};});
async function mockDisk(page:Page) {
 await page.addInitScript(()=>{
  const w=window as any;
  w.disk={saved:null,pickers:0,writes:0,mode:'ok',pending:null};
  const handle={name:'song.dawbae',getFile:async()=>new File([w.disk.saved ?? new Blob()], 'song.dawbae'),createWritable:async()=>{
   if(w.disk.mode==='permission')throw new DOMException('permission denied','NotAllowedError');
   let staged:Blob|null=null;
   return {write:async(b:Blob)=>{w.disk.writes++;if(w.disk.mode==='write')throw Error('disk full');if(w.disk.mode==='slow')await new Promise(r=>{w.disk.pending=r;});staged=b;},close:async()=>{if(w.disk.mode==='close')throw Error('close failed');w.disk.saved=staged;},abort:async()=>{staged=null;}};
  }};
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>{w.disk.pickers++;if(w.disk.mode==='cancel')throw new DOMException('cancel','AbortError');return handle;}});
  Object.defineProperty(window,'showOpenFilePicker',{configurable:true,value:async()=>[handle]});
 });
}
test('offline .dawbae download → fresh profile open: original audio, tracks and playback events survive; no cloud traffic',async({page,browser})=>{
 test.setTimeout(120000);const api:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/'))api.push(r.url());});
 await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 await newProject(page,'파일 테스트');
 await expect(page.getByTestId('file-status')).toHaveText('파일 미저장');
 for(const name of ['+ Bass TAB','+ Drums']) {await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(1500);}
 await page.evaluate(()=>{const s=(window as any).__bassdaw.state(),t=s.project.tracks.find((t:any)=>t.kind==='drum'),src=s.project.sources.find((x:any)=>x.id===t.clips[0].sourceId);s.run('hit',{type:'EditNotes',clipId:t.clips[0].id,ops:[{op:'add',collection:'hits',item:{id:'local-hit',tick:0,padId:src.pads[0].id,velocity:39}}]});});
 const before=await state(page);
 await page.context().setOffline(true);
 const event=page.waitForEvent('download');await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();const dl=await event;
 expect(dl.suggestedFilename()).toBe('파일 테스트.dawbae');await dl.saveAs(`${OUT}/song.dawbae`);
 expect(readFileSync(`${OUT}/song.dawbae`).subarray(0,2).toString()).toBe('PK');
 await expect(page.getByTestId('file-status')).toHaveText('파일 다운로드 요청됨');expect((await state(page)).project).toEqual(before.project);expect(api).toEqual([]);
 await expect(page.getByRole('tab',{name:'동기화',exact:true})).toHaveCount(0);
 const ctx=await browser.newContext(),other=await ctx.newPage();await other.goto(BASE);await expect(other.getByRole('button',{name:'파일 열기 (.dawbae)',exact:true})).toBeEnabled();
 await other.getByLabel('프로젝트 파일 열기',{exact:true}).setInputFiles(`${OUT}/song.dawbae`);
 await expect(other.getByLabel('프로젝트 제목',{exact:true})).toHaveValue('파일 테스트');
 const after=await state(other);expect(after.project.tracks).toEqual(before.project.tracks);expect(after.project.sources).toEqual(before.project.sources);expect(after.project.assets).toEqual(before.project.assets);expect(after.plan).toEqual(before.plan);
 const hashes=await other.evaluate(async()=>{const s=(window as any).__bassdaw.state();return Promise.all(s.project.assets.map(async(a:any)=>{const b=await s.store.readAsset(a.sha256);return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');}));});
 expect(hashes).toEqual(before.project.assets.map((a:any)=>a.sha256));await ctx.close();
});
test('native file contract: Save, Ctrl+S from title input, Save As cancel, permission/write failure and edits during save',async({page})=>{
 test.setTimeout(120000);await mockDisk(page);await newProject(page,'Direct');
 await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();await expect(page.getByTestId('file-status')).toHaveText('파일 저장됨');
 expect(await page.evaluate(()=>(window as any).disk.pickers)).toBe(1);
 await page.getByLabel('프로젝트 제목',{exact:true}).fill('Changed');await page.keyboard.press('Control+s');await expect(page.getByTestId('file-status')).toHaveText('파일 저장됨');
 expect(await page.evaluate(()=>(window as any).disk.pickers)).toBe(1);
 const last=await page.evaluate(async()=>[...new Uint8Array(await (window as any).disk.saved.arrayBuffer())]);
 await page.evaluate(()=>{(window as any).disk.mode='cancel';});await page.getByRole('button',{name:'다른 이름으로 저장',exact:true}).click();await expect(page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true})).toBeEnabled();await expect(page.getByTestId('file-status')).toHaveText('파일 저장됨');
 for(const mode of ['permission','write','close']) {
  await page.evaluate(mode=>{(window as any).disk.mode=mode;},mode);await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();await expect(page.getByTestId('file-status')).toHaveText('파일 저장 실패');
  expect(await page.evaluate(async()=>[...new Uint8Array(await (window as any).disk.saved.arrayBuffer())])).toEqual(last);
 }
 await page.evaluate(()=>{(window as any).disk.mode='slow';});await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();await page.waitForFunction(()=>!!(window as any).disk.pending);
 await page.getByLabel('프로젝트 제목',{exact:true}).fill('Edited during save');await page.getByLabel('프로젝트 제목',{exact:true}).blur();
 await page.evaluate(()=>{(window as any).disk.pending();});await expect(page.getByTestId('file-status')).toHaveText('파일 미저장');
 await page.evaluate(()=>{(window as any).disk.mode='ok';});await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();await expect(page.getByTestId('file-status')).toHaveText('파일 저장됨');
 await page.getByRole('button',{name:'프로젝트 목록',exact:true}).click();await page.getByRole('button',{name:'파일 열기 (.dawbae)',exact:true}).click();await expect(page.getByLabel('프로젝트 제목',{exact:true})).toHaveValue('Edited during save');
});
test('legacy .bassdaw opens and corrupt .dawbae is rejected without replacing an existing project',async({page})=>{
 await mockDisk(page);await newProject(page,'Legacy');await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();await expect(page.getByTestId('file-status')).toHaveText('파일 저장됨');
 const bytes=Buffer.from(await page.evaluate(async()=>[...new Uint8Array(await (window as any).disk.saved.arrayBuffer())]));
 await page.getByRole('button',{name:'프로젝트 목록',exact:true}).click();await page.getByLabel('프로젝트 파일 열기',{exact:true}).setInputFiles({name:'old.bassdaw',mimeType:'application/zip',buffer:bytes});await expect(page.getByLabel('프로젝트 제목',{exact:true})).toHaveValue('Legacy');
 await page.getByRole('button',{name:'프로젝트 목록',exact:true}).click();const count=await page.locator('tbody tr').count();
 await page.getByLabel('프로젝트 파일 열기',{exact:true}).setInputFiles({name:'broken.dawbae',mimeType:'application/zip',buffer:Buffer.from('not a zip')});await expect(page.locator('.toast.error')).toContainText('Import refused');expect(await page.locator('tbody tr').count()).toBe(count);
});
