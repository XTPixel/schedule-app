// A real two-hour native workload, isolated from the user's data and credentials.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const{spawn,execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,durationMs=2*60*60*1000;
const out=path.join(root,'.build-cache/windows-soak',version+'-'+Date.now()),dir=path.join(out,'data');
const wait=ms=>new Promise(r=>setTimeout(r,ms));let client,child,config,startedAt,cycles=0;const samples=[],checks=[];
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.moment-qa-root'),'moment-isolated-test-data-v1');
const exe=path.join(out,'schedule-app.exe');fs.copyFileSync(path.join(process.env.CARGO_TARGET_DIR,'debug/schedule-app.exe'),exe);
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
function record(phase,extra={}){const value={recordedAt:new Date().toISOString(),version,phase,startedAt,requiredDurationMs:durationMs,elapsedMs:startedAt?Date.now()-Date.parse(startedAt):0,cycles,binarySha256,isolatedDirectory:dir,samples,checks,...extra};fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(value,null,2));fs.writeFileSync(path.join(root,'.build-cache/windows-soak/latest.json'),JSON.stringify(value,null,2));return value}
async function until(fn){for(let n=0;n<80;n++){try{if(await fn())return}catch{}await wait(200)}throw Error('Soak application state did not become ready')}
async function main(){
 try{await fetch('http://127.0.0.1:9226/json/list');throw Error('QA port 9226 is already in use')}catch(e){if(/already in use/.test(String(e)))throw e}
 child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:dir,APPDATA:path.join(out,'roaming'),LOCALAPPDATA:path.join(out,'local'),WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9226'}});
 await until(async()=>{client=await Client.connect(9226);return Boolean(await client.invoke('load_all_data'))});
 await client.assertWindowsIsolation();
 assert.equal((await client.invoke('sync_get_status')).configured,false);const empty=await client.invoke('load_all_data');assert.equal(empty.events.length+empty.tasks.length+empty.longTasks.length+empty.routines.length,0);config=empty.config;
 const now=new Date().toISOString(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),common={id:'',title:'QA endurance',description:null,tags:['qa-endurance'],priority:'normal',createdAt:now,updatedAt:now,deletedAt:null};
 let task=await client.invoke('save_task',{task:{...common,deadline:null,sortOrder:0,status:'active',completedAt:null}});
 const long=await client.invoke('save_long_task',{task:{...common,title:'QA endurance timer',startDate:day,dueDate:day,status:'active',endedAt:null,sessions:[]}});
 await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(document.querySelector("main"))'));
 await until(()=>client.evaluate('[...document.querySelectorAll("main button")].some(x=>x.innerText.trim()==="开始")'));
 await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="开始").click()');
 await until(()=>client.evaluate('Object.values(JSON.parse(localStorage.getItem("schedule.timers.v1")||"{}")).some(x=>x.running)'));
 checks.push({name:'native marked data isolation and actual frontend timer start',passed:true});startedAt=new Date().toISOString();record('running');
 const views=['搜索','日历','归档','统计','长期','浮动','现在'];
 while(Date.now()-Date.parse(startedAt)<durationMs){
  assert.equal(child.exitCode,null,'Native process exited during the endurance workload');
  const at=new Date().toISOString();task=await client.invoke('save_task',{task:{...task,title:'QA endurance cycle '+cycles,priority:cycles%2?'normal':'high',updatedAt:at}});
  const data=await client.invoke('load_all_data');assert.equal(data.tasks.find(x=>x.id===task.id)?.title,task.title);
  const search=await client.invoke('search_data',{query:{text:'QA endurance cycle',tags:[],dateFrom:null,dateTo:null}});assert.ok(search.tasks.some(x=>x.id===task.id));
  const end=Date.now();await client.invoke('add_long_task_session',{input:{taskId:long.id,sessionId:'qa-soak-'+cycles,startedAt:new Date(end-1000).toISOString(),endedAt:new Date(end).toISOString(),durationMs:1000,note:'Synthetic endurance checkpoint'}});
  const stats=await client.invoke('get_stats',{days:30});assert.ok(stats.totals);await client.invoke('get_now_candidates',{now:at});
  await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes('+JSON.stringify(views[cycles%views.length])+')).click()');
  if(cycles>0&&cycles%30===0){
   const before=await client.evaluate('Object.values(JSON.parse(localStorage.getItem("schedule.timers.v1")||"{}")).reduce((n,t)=>n+t.accumulatedMs,0)');
   await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(document.querySelector("main"))'));
   const restored=await client.evaluate('Object.values(JSON.parse(localStorage.getItem("schedule.timers.v1")||"{}"))');assert.ok(restored.length>0&&restored.every(x=>!x.running),'Reload must restore timers paused');assert.ok(restored.reduce((n,t)=>n+t.accumulatedMs,0)>=before,'Timer checkpoint lost on renderer reload');
   await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("现在")).click()');
   await until(()=>client.evaluate('[...document.querySelectorAll("main button")].some(x=>x.innerText.trim()==="继续")'));
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="继续").click()');
  }
  if(cycles%15===0){const heap=await client.command('Runtime.getHeapUsage',{});const memory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${child.pid} | Select-Object WorkingSet64,PrivateMemorySize64,HandleCount | ConvertTo-Json -Compress`],{encoding:'utf8',timeout:10000}));samples.push({at:new Date().toISOString(),cycle:cycles,rendererUsedBytes:heap.usedSize,...memory});assert.ok(heap.usedSize<256*1024*1024,'Renderer heap exceeds 256 MiB');if(samples.length>1)assert.ok(memory.PrivateMemorySize64-samples[0].PrivateMemorySize64<256*1024*1024,'Native private-memory growth exceeds 256 MiB')}
  cycles++;record('running');await wait(Math.min(20000,Math.max(0,durationMs-(Date.now()-Date.parse(startedAt)))));
 }
 const final=await client.invoke('load_all_data');assert.equal(final.longTasks.find(x=>x.id===long.id).sessions.length,cycles);assert.ok(Date.now()-Date.parse(startedAt)>=durationMs);
 checks.push({name:'two actual hours of native writes, search, statistics, navigation, persisted sessions and renderer reloads',passed:true});
 const emptyDir=path.join(out,'empty-import');fs.mkdirSync(emptyDir);fs.writeFileSync(path.join(emptyDir,'config.json'),JSON.stringify(config));await client.invoke('import_data',{srcDir:emptyDir});assert.equal((await client.invoke('load_all_data')).tasks.length,0);checks.push({name:'isolated synthetic data cleanup',passed:true});record('passed');
}
main().catch(e=>{record('failed',{error:String(e)});console.error(String(e));process.exitCode=1}).finally(async()=>{if(client){try{await client.invoke('sync_exit')}catch(e){if(!/closed/.test(String(e))){console.error(String(e));process.exitCode=1}}client.close()}if(child&&child.exitCode===null){await wait(1000);if(child.exitCode===null)child.kill()}});
