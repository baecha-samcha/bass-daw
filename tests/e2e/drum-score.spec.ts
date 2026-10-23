import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {BASE,waitSaved} from './helpers.ts';
const OUT='tests/artifacts/drum-score';mkdirSync(OUT,{recursive:true});
const ids=['drum-short','drum-custom','drum-meter','drum-long'];
test('percussion proof screen and print: all heads, diagnostics, two voices, range and multi-page PDF',async({page})=>{
 test.setTimeout(240000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const id of ids) {
  await page.goto(`${BASE}?scoreCase=${id}#/score-check`);
  const sheet=page.getByTestId(`sheet-${id}`); await expect(sheet).toHaveAttribute('data-state','done',{timeout:60000});
  expect(await sheet.locator('svg').count()).toBeGreaterThan(0);
  if(id==='drum-short') {
   const glyphs=await sheet.locator('svg text').allTextContents();const text=glyphs.join('');
   for(const cp of [57449,57508,57513,57523,57563]) expect(text).toContain(String.fromCodePoint(cp));
   expect(text).not.toContain(String.fromCodePoint(0xe522)); // no inferred forte
   await expect(page.locator('.print-score-warnings')).toHaveCount(0);
  }
  await page.getByTestId(`case-${id}`).screenshot({path:`${OUT}/${id}.png`});
  await page.emulateMedia({media:'print'}); await page.waitForTimeout(300);
  const parts=await sheet.locator('.at-surface > div').evaluateAll(es=>es.map(e=>({break:getComputedStyle(e).breakInside,h:e.getBoundingClientRect().height})));
  expect(parts.filter(p=>p.break!=='avoid'||p.h>=1032)).toEqual([]);
  const file=`${OUT}/${id}.pdf`; await page.pdf({path:file,format:'A4',preferCSSPageSize:true});
  const text=execFileSync('pdftotext',['-layout',file,'-']).toString().replace(/\s+/g,' ');
  expect(text).toContain('Drum legend');expect(text).toContain('Kick');expect(text).not.toContain('TAB');
  if(id==='drum-custom'){expect(text).toContain('UNMAPPED_PAD');expect(text).toContain('unknown-hit');expect(text).toContain('UNSUPPORTED_RHYTHM');expect(text).toContain('INCOMPLETE SCORE');}
  if(id==='drum-long')expect(Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo',[file]).toString())![1])).toBeGreaterThan(1);
  if(id==='drum-meter')expect(text).toMatch(/마디 2.?4/);
  await page.emulateMedia({media:'screen'});
 }
 expect(errors).toEqual([]);
});
test('editor drum pad mapping preview + range + PDF preserves project, plan, save state',async({page})=>{
 test.setTimeout(180000);await page.goto(BASE);await page.getByLabel('새 프로젝트 제목').fill('Drum export');await page.getByRole('button',{name:'새 프로젝트',exact:true}).click();await page.getByRole('button',{name:'+ Drums',exact:true}).click();
 await page.waitForFunction(()=> (window as any).__bassdaw.state().project.assets.length>0);
 await page.evaluate(()=>{const w=window as any,s=w.__bassdaw.state(),p=s.project,src=p.sources.find((x:any)=>x.kind==='drum'),clip=p.tracks[0].clips[0];s.run('drum hits',{type:'EditNotes',clipId:clip.id,ops:src.pads.map((p:any,i:number)=>({op:'add',collection:'hits',item:{id:`dh${i}`,tick:i*480,padId:p.id,velocity:25+i*13}}))});});
 await page.getByRole('button',{name:'지금 저장'}).click();await waitSaved(page);
 const dbg=()=>page.evaluate(async()=>{const w=(window as any).__bassdaw;return {project:await w.projectHash(),plan:w.planHash().hash,seq:w.state().editSeq};});const before=await dbg();
 await page.getByRole('tab',{name:'악보',exact:true}).click();
 await expect(page.getByLabel('기보 악기 Kick')).toBeVisible();await expect(page.getByLabel('보표',{exact:true})).toHaveCount(0);
 await page.getByLabel('기보 악기 Kick').selectOption('');await expect(page.locator('[data-code="UNMAPPED_PAD"]')).toBeVisible();
 await page.getByRole('button',{name:'악보 미리보기',exact:true}).click();await expect(page.getByTestId('print-sheet')).toHaveAttribute('data-state','done',{timeout:60000});
 await expect(page.locator('.print-overlay .print-score-warnings')).toContainText('UNMAPPED_PAD');
 let printed=false;await page.exposeFunction('__drumPrintCalled',()=>{printed=true;});
 await page.evaluate(()=>{window.print=()=>{(window as any).__drumPrintCalled();};});
 await page.getByRole('button',{name:'인쇄 / PDF로 저장',exact:true}).click();expect(printed).toBe(true);
 await page.pdf({path:`${OUT}/editor-unmapped.pdf`,format:'A4',preferCSSPageSize:true});
 await page.getByRole('button',{name:'닫기',exact:true}).click();await page.getByLabel('기보 악기 Kick').selectOption('kick');
 await page.getByLabel('악보 범위').selectOption('bars');await page.getByLabel('시작 마디',{exact:true}).fill('1');await page.getByLabel('끝 마디',{exact:true}).fill('2');
 await page.getByRole('button',{name:'악보 미리보기',exact:true}).click();await expect(page.getByTestId('print-sheet')).toHaveAttribute('data-state','done',{timeout:60000});
 await page.getByRole('button',{name:'닫기',exact:true}).click();expect(await dbg()).toEqual(before);await expect(page.getByTestId('save-status')).toHaveText('저장됨');
});
test('measures isolated bass and drum short/120 bar renders and main-thread long tasks on this machine',async({page})=>{
 test.setTimeout(240000);const rows:unknown[]=[];
 await page.addInitScript(()=>{(window as any).__scoreTasks=[];new PerformanceObserver(l=>{for(const e of l.getEntries())(window as any).__scoreTasks.push({start:e.startTime,ms:e.duration});}).observe({type:'longtask',buffered:true});});
 for(const id of ['four-both','long','drum-short','drum-long']) {
  await page.goto(`${BASE}?scoreCase=${id}#/score-check`);await expect(page.getByTestId(`sheet-${id}`)).toHaveAttribute('data-state','done',{timeout:60000});await page.waitForTimeout(200);
  rows.push(await page.getByTestId(`sheet-${id}`).evaluate((el,id)=>{const tasks=(window as any).__scoreTasks;const renderTasks=tasks.filter((t:any)=>t.start+t.ms>=Number((el as HTMLElement).dataset.renderStarted)&&t.start<=Number((el as HTMLElement).dataset.renderFinished));return {id,renderLongTaskCount:renderTasks.length,renderLongTaskMaxMs:Math.max(0,...renderTasks.map((t:any)=>t.ms)),renderMs:Number((el as HTMLElement).dataset.renderMs),longTaskCount:tasks.length,longTaskTotalMs:tasks.reduce((s:number,t:any)=>s+t.ms,0),longTaskMaxMs:Math.max(0,...tasks.map((t:any)=>t.ms)),tasks};},id));
 }
 writeFileSync(`${OUT}/performance.json`,JSON.stringify({environment:'Raspberry Pi headless Chromium; NOT Chromebook',scope:'single navigation per fixture; long tasks include cold navigation/import; renderMs excludes dynamic import',rows},null,2));console.log(JSON.stringify(rows));
});
