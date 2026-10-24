// Repeated real Android lifecycle transitions, using synthetic local data only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const serial='emulator-5558',pkg='com.personal.schedule',port=9227,root=path.resolve(__dirname,'..'),out=path.join(root,'.build-cache/android-evidence');
const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),shell=(...a)=>execFileSync(adb,['-s',serial,...a],{encoding:'utf8',timeout:30000}),wait=ms=>new Promise(r=>setTimeout(r,ms));let client,task,originalTimers,processRecovery;const results=[],samples=[];
async function until(fn){for(let n=0;n<80;n++){try{if(await fn())return}catch(e){if(!/Execution context was destroyed|undefined/.test(String(e)))throw e}await wait(100)}throw Error('Android lifecycle state did not become ready')}
async function attach(){for(let n=0;n<50;n++){try{const pid=shell('shell','pidof',pkg).trim();shell('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+pid);client=await Client.connect(port);return}catch{await wait(200)}}throw Error('Owned emulator WebView unavailable')}
async function check(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name)}catch(e){results.push({name,passed:false,error:String(e)});throw e}}
const timer=()=>client.evaluate('JSON.parse(localStorage.getItem("schedule.timers.v1")||"{}")['+JSON.stringify(task.id)+']');
async function main(){
 assert.equal(shell('emu','avd','name').trim().split(/\s+/)[0],'Moment_API36');assert.equal(shell('shell','getprop','ro.build.version.sdk').trim(),'36');await attach();assert.equal((await client.invoke('sync_get_status')).configured,false);assert.equal(await client.invoke('plugin:app|version'),require('../package.json').version);
 originalTimers=await client.evaluate('localStorage.getItem("schedule.timers.v1")');const now=new Date(await client.evaluate('Date.now()')).toISOString(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(now));
 task=await client.invoke('save_long_task',{task:{id:'',title:'QA lifecycle timer '+Date.now(),description:null,tags:['qa-lifecycle'],priority:'normal',createdAt:now,updatedAt:now,deletedAt:null,startDate:day,dueDate:day,status:'active',endedAt:null,sessions:[]}});
 await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("现在")).click()');
 await until(()=>client.evaluate('[...document.querySelectorAll("main h3")].some(x=>x.innerText==='+JSON.stringify(task.title)+')'));
 await check('the unique synthetic task starts through its visible card button',async()=>{
  await client.evaluate('(()=>{const h=[...document.querySelectorAll("main h3")].find(x=>x.innerText==='+JSON.stringify(task.title)+');const card=h.closest("button").parentElement;[...card.querySelectorAll("button")].find(x=>x.innerText.trim()==="开始").click()})()');await until(async()=>(await timer())?.running===true);
 });
 await check('twenty Home and launcher returns preserve one monotonic running timer',async()=>{
  const started=await client.evaluate('Date.now()');let previous=0;
  for(let n=0;n<20;n++){
   shell('shell','input','keyevent','KEYCODE_HOME');await wait(350);shell('shell','am','start','-n',pkg+'/.MomentLauncherActivity');await until(()=>client.evaluate('document.visibilityState==="visible"'));await wait(100);
   const value=await timer();assert.equal(value.running,true);assert.ok(value.accumulatedMs>=previous);previous=value.accumulatedMs;samples.push({cycle:n+1,accumulatedMs:value.accumulatedMs});
  }
  const value=await timer(),end=await client.evaluate('Date.now()'),elapsed=value.accumulatedMs+(end-value.startedAt);assert.ok(elapsed>=end-started-2000&&elapsed<=end-started+2000,JSON.stringify({elapsed,wallMs:end-started}));assert.equal((await client.invoke('load_all_data')).longTasks.find(x=>x.id===task.id).sessions.length,0);
 });
 await check('process death restores a recent checkpoint paused without recording closed time or duplicate sessions',async()=>{
  const snapshot=await client.evaluate('({at:Date.now(),timer:JSON.parse(localStorage.getItem("schedule.timers.v1")||"{}")['+JSON.stringify(task.id)+']})'),before=snapshot.timer;assert.ok(before.accumulatedMs>10000);
  const stopStart=Date.now();client.close();client=null;shell('shell','am','force-stop',pkg);const stopLatency=Date.now()-stopStart;await wait(2500);shell('shell','am','start','-n',pkg+'/.MomentLauncherActivity');await attach();await until(async()=>(await timer())?.running===false);
  const restored=await timer();assert.equal(restored.startedAt,0);
  // WebView localStorage can acknowledge a write before its LevelDB commit.
  // Require recovery within one checkpoint period; never add closed time.
  assert.ok(restored.accumulatedMs>=before.accumulatedMs-10000&&restored.accumulatedMs>0);
  assert.ok(restored.accumulatedMs<=before.accumulatedMs+Math.max(0,snapshot.at-before.startedAt)+stopLatency+100);
  assert.equal((await client.invoke('load_all_data')).longTasks.find(x=>x.id===task.id).sessions.length,0);
  processRecovery={beforeCheckpointMs:before.accumulatedMs,restoredCheckpointMs:restored.accumulatedMs,rollbackMs:Math.max(0,before.accumulatedMs-restored.accumulatedMs),stopLatencyMs:stopLatency,closedDelayMs:2500};
 });
}
main().catch(e=>{console.error(String(e));process.exitCode=1}).finally(async()=>{try{if(client){if(task)await client.invoke('delete_long_task',{id:task.id});if(originalTimers!==undefined)await client.evaluate(originalTimers===null?'localStorage.removeItem("schedule.timers.v1");location.reload();true':'localStorage.setItem("schedule.timers.v1",'+JSON.stringify(originalTimers)+');location.reload();true')}}catch(e){if(!/Execution context was destroyed/.test(String(e))){console.error('Lifecycle cleanup: '+String(e));process.exitCode=1}}if(client)client.close();fs.writeFileSync(path.join(out,'lifecycle-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),version:require('../package.json').version,api:36,samples,processRecovery,results},null,2))});
