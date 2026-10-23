// Read-only public deployment checks plus synthetic projects saved only in the browser/downloads.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const base = process.argv[2] ?? 'https://daw.baecha.xyz';
const out = 'tests/artifacts/deployment'; mkdirSync(out,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',args:['--autoplay-policy=no-user-gesture-required']});
const results={base,at:new Date().toISOString(),environment:'Raspberry Pi / headless Chromium; not Chromebook or physical printer',assets:[],errors:[],apiRequests:[]};
try {
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}});
 await context.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 const page=await context.newPage();page.on('pageerror',e=>results.errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/'))results.apiRequests.push(r.url());});
 for(const path of ['/','/sw.js','/manifest.webmanifest','/alphatab/font/Bravura.woff2','/alphatab/LICENSE','/plugins/index.json']) {
  const r=await context.request.get(base+path); assert.equal(r.status(),200,path);
  for(const [name,value] of [['cross-origin-opener-policy','same-origin'],['cross-origin-embedder-policy','require-corp'],['cross-origin-resource-policy','same-origin']])assert.equal(r.headers()[name],value,path+' '+name);
  results.assets.push({path,status:r.status()});
 }
 await page.goto(base);await page.getByLabel('새 프로젝트 제목').fill('Deployment smoke');await page.getByRole('button',{name:'새 프로젝트',exact:true}).click();
 results.isolation=await page.evaluate(()=>({secureContext:isSecureContext,crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined'}));assert.ok(Object.values(results.isolation).every(Boolean));
 for(const name of ['+ Bass TAB','+ Drums']){await page.getByRole('button',{name,exact:true}).click();}
 await page.waitForFunction(()=>{const p=window.__bassdaw.state().project;return p.tracks.length===2&&p.tracks.every(t=>{const s=p.plugins.find(p=>p.instanceId===t.instrumentSlot)?.state;return t.kind==='drum'?s?.pads?.length:s?.zones?.length;});});
 await page.evaluate(()=>{const s=window.__bassdaw.state(),t=s.project.tracks.find(t=>t.kind==='drum'),src=s.project.sources.find(s=>s.id===t.clips[0].sourceId);s.run('smoke hit',{type:'EditNotes',clipId:t.clips[0].id,ops:[{op:'add',collection:'hits',item:{id:'smoke-hit',tick:0,padId:src.pads[0].id,velocity:83}}]});});
 const plan=await page.evaluate(()=>window.__bassdaw.planHash());
 await page.getByRole('button',{name:'🔊 오디오 시작',exact:true}).click();await page.getByRole('button',{name:'재생',exact:true}).click();await page.waitForFunction(()=>window.__bassdaw.engine.state==='playing');await page.getByRole('button',{name:'정지',exact:true}).click();results.audioPlayback=true;
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'파일 저장 (.dawbae)',exact:true}).click();const file=await download;assert.ok(file.suggestedFilename().endsWith('.dawbae'));await file.saveAs(`${out}/public-smoke.dawbae`);assert.equal(readFileSync(`${out}/public-smoke.dawbae`).subarray(0,2).toString(),'PK');results.fileDownload=true;
 const before=await page.evaluate(async()=>({hash:await window.__bassdaw.projectHash(),seq:window.__bassdaw.state().editSeq}));
 await page.getByRole('tab',{name:'악보',exact:true}).click();await page.getByLabel('악보 트랙').selectOption({label:'Drums'});await page.getByRole('button',{name:'악보 미리보기',exact:true}).click();await page.locator('[data-testid="print-sheet"][data-state="done"]').waitFor({timeout:60000});assert.ok(await page.getByTestId('print-sheet').locator('svg').count());await page.getByTestId('drum-legend').waitFor();
 await page.screenshot({path:`${out}/public-drum-score.png`,fullPage:true});await page.pdf({path:`${out}/public-drum-score.pdf`,format:'A4',preferCSSPageSize:true});results.drumScoreAndPdf=true;
 await page.getByRole('button',{name:'닫기',exact:true}).click();await page.getByLabel('악보 트랙').selectOption({label:'Bass'});await page.getByRole('button',{name:'악보 미리보기',exact:true}).click();await page.locator('[data-testid="print-sheet"][data-state="done"]').waitFor({timeout:60000});results.bassScore=true;await page.getByRole('button',{name:'닫기',exact:true}).click();
 assert.deepEqual(await page.evaluate(async()=>({hash:await window.__bassdaw.projectHash(),seq:window.__bassdaw.state().editSeq})),before);
 const fresh=await browser.newContext(),other=await fresh.newPage();await other.goto(base);await other.getByRole('button',{name:'파일 열기 (.dawbae)',exact:true}).waitFor();await other.waitForFunction(()=>!!window.__bassdaw?.state().store);await other.getByLabel('프로젝트 파일 열기',{exact:true}).setInputFiles(`${out}/public-smoke.dawbae`);await other.getByLabel('프로젝트 제목',{exact:true}).waitFor();assert.deepEqual(await other.evaluate(()=>window.__bassdaw.planHash()),plan);results.fileReopenAndPlaybackHash=true;
 assert.deepEqual(results.apiRequests,[]);assert.deepEqual(results.errors,[]);results.ok=true;
} catch(e){results.ok=false;results.failure=e.message;throw e;} finally {writeFileSync(`${out}/public-smoke.json`,JSON.stringify(results,null,2));await browser.close();console.log(JSON.stringify(results,null,2));}
