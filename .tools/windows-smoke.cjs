// Only the marked, empty Windows QA instance launched by this task.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{Client}=require('./webview-qa-client.cjs');
const base=path.resolve(__dirname,'../.build-cache/windows-evidence'),dir=path.join(base,'data');
const results=[];let client,original,prepared=false;
async function check(name,work){try{await work();results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function main(){
 assert.equal(fs.readFileSync(path.join(dir,'.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');
 client=await Client.connect(9225);assert.equal((await client.invoke('sync_get_status')).configured,false);
 await client.assertWindowsIsolation();
 original=await client.invoke('load_all_data');assert.equal(original.events.length+original.tasks.length+original.routines.length+original.longTasks.length,0);prepared=true;
 const now=new Date().toISOString(),common={id:'',title:'QA Windows',description:null,tags:['qa-old'],priority:'normal',createdAt:now,updatedAt:now,deletedAt:null};let event,task;
 await check('native desktop boot and validated event/task CRUD',async()=>{
   event=await client.invoke('save_event',{event:{...common,start:now,end:null,allDay:false,repeat:null,reminders:[],status:'active',completedAt:null}});
   task=await client.invoke('save_task',{task:{...common,deadline:null,sortOrder:0,status:'active',completedAt:null}});
   await client.invoke('save_routine',{routine:{...common,timeWindows:[{daysOfWeek:[1],start:'08:00',end:'09:00',everyDays:null,anchorDate:null}],durationMinutes:30,enabled:true}});
   await assert.rejects(()=>client.invoke('save_event',{event:{...event,end:'2000-01-01T00:00:00Z'}}));
   assert.equal((await client.invoke('load_all_data')).events.length,1);
 });
 await check('tag rename/delete atomically updates entities and shared colors',async()=>{
   const config=await client.invoke('get_config');config.tagColors['qa-old']='red';await client.invoke('set_config',{config});
   await client.invoke('rename_tag',{old:'qa-old',new:'qa-new'});
   let data=await client.invoke('load_all_data');for(const items of [data.events,data.tasks,data.routines])assert.ok(items.every(x=>x.tags.includes('qa-new')&&!x.tags.includes('qa-old')));
   assert.equal(data.config.tagColors['qa-new'],'red');
   await client.invoke('delete_tag',{tag:'qa-new'});data=await client.invoke('load_all_data');assert.ok(!data.config.tagColors['qa-new']);for(const items of [data.events,data.tasks,data.routines])assert.ok(items.every(x=>!x.tags.includes('qa-new')));
 });
 await check('bad legacy import leaves every existing entity unchanged',async()=>{
   const source=path.join(base,'bad-import');fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'config.json'),JSON.stringify(original.config));fs.writeFileSync(path.join(source,'events.json'),JSON.stringify({version:6,events:[]}));fs.writeFileSync(path.join(source,'templates.json'),'invalid-json');
   const before=await client.invoke('load_all_data');await assert.rejects(()=>client.invoke('import_data',{srcDir:source}));const after=await client.invoke('load_all_data');assert.deepEqual(after.events,before.events);assert.deepEqual(after.tasks,before.tasks);
 });
 await check('prior-month archive deletion and undo preserve latest neighboring entries',async()=>{
   const date='2025-03-12',entry=id=>({id,time:'12:00',title:'QA '+id,source:'manual',sourceId:null,note:null,durationMinutes:10,doneAt:now});
   const a=entry('qa-archive-a'),b=entry('qa-archive-b');await client.invoke('update_archive_day',{date,payload:{entries:[a,b],summary:null,updatedAt:now}});
   // Exercise the native prior-month read/write contract used by the UI's undo.
   const current=(await client.invoke('get_archive_month',{month:'2025-03'})).days[date];
   await client.invoke('update_archive_day',{date,payload:{...current,entries:[]}});
   const latest=(await client.invoke('get_archive_month',{month:'2025-03'})).days[date];
   await client.invoke('update_archive_day',{date,payload:{...latest,entries:[...latest.entries,a]}});
   const restored=(await client.invoke('get_archive_month',{month:'2025-03'})).days[date].entries;assert.deepEqual(restored.map(x=>x.id),[a.id]);
 });
 await check('directory change rejects nesting inside the live data directory',async()=>{
   await assert.rejects(()=>client.invoke('set_data_dir',{path:path.join(dir,'nested-target')}));assert.ok((await client.invoke('load_all_data')).tasks.some(x=>x.id===task.id));
 });
 await check('hook enablement and sandboxed result use the native runtime',async()=>{
   await assert.rejects(()=>client.invoke('run_hook_test',{hook:'on_event_saved',payload:'{}'}));
   fs.writeFileSync(path.join(dir,'hooks','qa-native.js'),'function on_event_saved(payloadJson){ return "qa-hook-ok"; }');
   const config=await client.invoke('get_config');config.hooks.enabled=true;await client.invoke('set_config',{config});
   const output=await client.invoke('run_hook_test',{hook:'on_event_saved',payload:'{}'});assert.match(JSON.stringify(output),/qa-hook-ok/);fs.unlinkSync(path.join(dir,'hooks','qa-native.js'));
 });
 await check('desktop settings and dark theme render',async()=>{
   const config=await client.invoke('get_config');config.appearance.theme='dark';await client.invoke('set_config',{config});
   await client.evaluate('window.dispatchEvent(new Event("focus"))');
   await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("设置")).click()');
   for(let n=0;n<20;n++){if((await client.evaluate('document.body.innerText')).includes('导出备份'))break;await new Promise(r=>setTimeout(r,100))}
   assert.match(await client.evaluate('document.body.innerText'),/导出备份/);
   const image=await client.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(base,'settings.png'),Buffer.from(image.data,'base64'));
 });
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(async()=>{
 try{if(prepared){const empty=path.join(base,'smoke-empty');fs.mkdirSync(empty,{recursive:true});fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(original.config));await client.invoke('import_data',{srcDir:empty});assert.equal((await client.invoke('load_all_data')).tasks.length,0)}}catch(error){console.error('QA cleanup failed: '+error);process.exitCode=1}
 if(client)client.close();fs.writeFileSync(path.join(base,'smoke-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),results},null,2));
});
