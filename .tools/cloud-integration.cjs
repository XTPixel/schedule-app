// Uses existing app credentials through an opt-in native loopback bridge.
// All remote writes stay under the exact human-authorized moment-qa/ prefix.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');const assert=require('node:assert/strict');const {Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.build-cache','cloud-evidence');
fs.mkdirSync(out,{recursive:true});
const windowsOnly=process.env.MOMENT_WINDOWS_CLOUD_ONLY==='1';
const serial=windowsOnly?null:require('./authorized-phone.cjs').authorizedPhone();
const adb=path.join(process.env.ANDROID_HOME,'platform-tools','adb.exe');
const native=path.dirname(process.env.CARGO_TARGET_DIR),exe=path.join(process.env.CARGO_TARGET_DIR,'debug','schedule-app.exe');
const helper=path.join(process.env.CARGO_TARGET_DIR,'debug','examples','cloud_qa_credentials.exe');
const prefix=process.env.MOMENT_CLOUD_QA_PREFIX;
assert.equal(prefix,'moment-qa/20261024-beta2-d43f80a3','Only the explicitly authorized QA prefix is allowed');
const results=[];let windows,phone,phoneRestoreId,phoneBefore,phonePrepared=false,phoneRestored=false,windowsPrepared=false,windowsConfig;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const localConfig=config=>Object.fromEntries(['timezone','appearance','behavior','notifications','hooks','dataDir'].map(key=>[key,config[key]]));
async function business(client){const data=await client.invoke('load_all_data');return{events:data.events,routines:data.routines,tasks:data.tasks,longTasks:data.longTasks,templates:await client.invoke('list_templates'),currentArchive:data.archive,olderArchive:await client.invoke('get_archive_month',{month:'2025-01'}),tagColors:data.config.tagColors,candidate:data.config.candidate}}
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000});
async function connect(port){for(let n=0;n<30;n++){try{return await Client.connect(port)}catch{await wait(500)}}throw Error('Application bridge not ready: '+port)}
async function action(client,name,args={}){for(let n=0;n<180;n++){if((await client.invoke('sync_get_status')).syncing){await wait(500);continue}try{return await client.invoke(name,args)}catch(error){if(!String(error).includes('同步正在进行'))throw error}}throw Error('Application stayed busy for 90 seconds')}
function forwardPhone(){const pid=shell('shell','pidof','com.personal.schedule').trim();assert.match(pid,/^\d+$/);shell('forward','tcp:9224','localabstract:webview_devtools_remote_'+pid)}
function canonical(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)}
function phoneFiles(){
 const names=shell('shell','run-as','com.personal.schedule','ls').split(/\s+/),files=['config.json','events.json','routines.json','tasks.json','long_tasks.json','templates.json'].filter(n=>names.includes(n));
 if(names.includes('archive'))for(const name of shell('shell','run-as','com.personal.schedule','ls','archive').split(/\s+/))if(/^\d{4}-\d{2}\.json$/.test(name))files.push('archive/'+name);
 return files.sort();
}
function phoneFingerprint(){return phoneFiles().map(file=>{const raw=shell('exec-out','run-as','com.personal.schedule','cat',file);return{file,sha256:crypto.createHash('sha256').update(canonical(JSON.parse(raw))).digest('hex')}})}
async function backupPhone(){
 assert.equal((await phone.invoke('sync_get_status')).configured,false,'Refusing to replace an existing phone sync profile');
 const files=phoneFiles();assert.ok(files.includes('config.json')&&files.length>1,'Phone business files were not found in the expected app directory');
 phoneBefore=phoneFingerprint();
 const archive=execFileSync(adb,['-s',serial,'exec-out','run-as','com.personal.schedule','tar','-cf','-',...files],{timeout:30000,maxBuffer:128*1024*1024});
 fs.writeFileSync(path.join(out,'phone-pre-cloud-data.tar'),archive);
 fs.writeFileSync(path.join(out,'phone-pre-cloud-fingerprints.json'),JSON.stringify(phoneBefore,null,2));phonePrepared=true;
}
async function restorePhone(){
 if(!phone){shell('shell','am','start','-n','com.personal.schedule/.MainActivity');await wait(500);forwardPhone();phone=await connect(9224)}
 if((await phone.invoke('sync_get_status')).configured)await action(phone,'sync_disconnect');
 if(phoneRestoreId)await phone.invoke('restore_recovery_point',{id:phoneRestoreId});
 assert.equal((await phone.invoke('sync_get_status')).configured,false);
 assert.deepEqual(phoneFingerprint(),phoneBefore,'Phone business data differs from the pre-cloud backup');phoneRestored=true;
}
async function check(name,fn){const start=Date.now();try{await fn();results.push({name,passed:true,ms:Date.now()-start});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function exit(client){
 await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("设置")).click()');
 for(let n=0;n<100;n++){if(await client.evaluate('[...document.querySelectorAll("button")].some(x=>x.innerText.trim()==="同步并退出"&&!x.disabled)'))break;assert.ok(n<99,'Visible handoff button must become ready');await wait(100)}
 try{await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="同步并退出").click()')}catch(error){if(!/closed/.test(String(error)))throw error}
 for(let n=0;n<300;n++){try{await client.evaluate('true')}catch(error){if(/closed/.test(String(error))){client.close();await wait(600);return}throw error}await wait(100)}throw Error('Visible cloud handoff did not exit');
}
async function restartWindows(){
 const evidence=path.join(root,'.build-cache','windows-evidence');
 const child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:path.join(evidence,'data'),APPDATA:path.join(evidence,'roaming'),LOCALAPPDATA:path.join(evidence,'local'),WEBVIEW2_USER_DATA_FOLDER:path.join(evidence,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225'}});
 child.unref();fs.writeFileSync(path.join(evidence,'pid.txt'),String(child.pid));const client=await connect(9225);await client.assertWindowsIsolation();return client;
}
async function bootstrap(){
 const token=crypto.randomBytes(32).toString('hex');let completed=false;
 const server=http.createServer(async(req,res)=>{
   if(req.method!=='POST'||req.url!=='/bootstrap'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return}
   try{
     let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw Error('bootstrap too large')}
     const input=JSON.parse(raw);
     assert.equal(input.bucket,'moment-app');
     assert.equal((await windows.invoke('sync_get_status')).configured,false);
     await windows.invoke('set_config',{config:await windows.invoke('get_config')});
     assert.ok(fs.existsSync(path.join(root,'.build-cache','windows-evidence','data','config.json')),'isolated Windows directory must be verified before credential use');
     if(phone)assert.equal((await phone.invoke('sync_get_status')).configured,false);
     await action(windows,'sync_configure',{input:{...input,prefix,deviceName:'QA Windows'}});
     if(phone){
       // Claim Windows first, before enabling the phone's automatic tick.
       await action(windows,'sync_now');
       await action(phone,'sync_configure',{input:{...input,prefix,deviceName:'QA HONOR70'}});
     }
     completed=true;res.writeHead(200);res.end('configured');
   }catch{res.writeHead(500);res.end('bootstrap failed')}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
   const child=spawn(helper,[],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MOMENT_ALLOW_CLOUD_QA:'1',MOMENT_QA_BOOTSTRAP:'http://127.0.0.1:'+server.address().port+'/bootstrap',MOMENT_QA_TOKEN:token}});
   let safeError='';child.stderr.on('data',b=>safeError+=b);
   const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)});
   if(code!==0||!completed)throw Error(safeError.trim()||'Native credential bridge failed');
 }finally{server.close()}
}
async function main(){
 assert.equal(fs.readFileSync(path.join(root,'.build-cache/windows-evidence/data/.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');
 windows=await restartWindows();
 const initial=await windows.invoke('load_all_data');assert.equal(initial.tasks.length+initial.events.length+initial.routines.length+initial.longTasks.length,0,'Windows fixture must start empty');windowsConfig=initial.config;assert.equal((await windows.invoke('sync_get_status')).configured,false);windowsPrepared=true;
 if(!windowsOnly){forwardPhone();phone=await connect(9224);await check('preserve complete phone business files before cloud configuration',backupPhone);}
 await check('bootstrap isolated clients without exposing credentials',bootstrap);
 await check('real Qiniu create-only check rejects overwrites',()=>action(windows,'sync_test_connection'));
 if(windowsOnly){
   let probeTask;
   await check('Windows uploads an encrypted synthetic QA task',async()=>{
     assert.equal((await action(windows,'sync_now')).editable,true);
     const now=new Date().toISOString();
     probeTask=await windows.invoke('save_task',{task:{id:'',title:'QA cloud Windows connection probe',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});
     const status=await action(windows,'sync_now');assert.ok(status.revision>=2);assert.equal(status.dirty,false);
   });
   await check('Windows downloads and decrypts cloud data while preserving the replaced local copy',async()=>{
     await windows.invoke('save_task',{task:{...probeTask,title:'QA local copy before explicit download'}});
     const before=await windows.invoke('recovery_points');
     await action(windows,'sync_resolve_initial',{input:{choice:'download'}});
     const saved=(await windows.invoke('load_all_data')).tasks.filter(t=>t.id===probeTask.id);
     assert.equal(saved.length,1);assert.equal(saved[0].title,probeTask.title);
     assert.ok((await windows.invoke('recovery_points')).some(id=>!before.includes(id)));
     assert.equal((await windows.invoke('sync_get_status')).dirty,false);
   });
   await check('Windows disconnect preserves QA data and releases its lease',async()=>{await action(windows,'sync_disconnect');assert.equal((await windows.invoke('sync_get_status')).configured,false)});
   return;
 }
 await check('Windows claims lease; phone is blocked from writing',async()=>{
   assert.equal((await action(windows,'sync_now')).editable,true);
   await assert.rejects(()=>action(phone,'sync_now'));
   assert.equal((await phone.invoke('sync_get_status')).editable,false);
 });
 let task,fixture,published,returned,phoneLocalConfig;
 await check('Windows uploads native QA edit',async()=>{
   const now=new Date().toISOString();
   task=await windows.invoke('save_task',{task:{id:'',title:'QA cloud Windows',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});
   const s=await action(windows,'sync_now');assert.ok(s.revision>=2);assert.equal(s.dirty,false);
 });
 await check('Windows publishes every entity, idempotent effective-time session, cross-month archive and shared config',async()=>{
   const now=new Date().toISOString(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),common={description:null,priority:'normal',tags:['cloud-qa'],createdAt:now,updatedAt:now,deletedAt:null};
   const event=await windows.invoke('save_event',{event:{...common,id:'',title:'QA cloud daily event',start:now,end:null,allDay:false,reminders:[],repeat:{type:'daily',interval:1,daysOfWeek:[],end:null},status:'active',completedAt:null}});
   const routine=await windows.invoke('save_routine',{routine:{...common,id:'',title:'QA cloud overnight routine',timeWindows:[{daysOfWeek:[],start:'23:00',end:'01:00',everyDays:2,anchorDate:day}],durationMinutes:30,enabled:true}});
   const long=await windows.invoke('save_long_task',{task:{...common,id:'',title:'QA cloud long task',startDate:day,dueDate:day,status:'active',endedAt:null,sessions:[]}});
   const end=Date.now(),sessionId='qa-cloud-session-'+end,input={taskId:long.id,startedAt:new Date(end-120000).toISOString(),endedAt:new Date(end).toISOString(),durationMs:60000,note:'QA effective minute',sessionId};
   await windows.invoke('add_long_task_session',{input});await windows.invoke('add_long_task_session',{input});
   let template=await windows.invoke('make_template_default',{kind:'custom'});template.name='QA cloud template';template.items[0].title='QA cloud template item';template=await windows.invoke('save_template',{template});
   await windows.invoke('update_archive_day',{date:'2025-01-15',payload:{entries:[{id:'qa-cloud-archive-'+end,time:'12:00',title:'QA cloud older archive',source:'manual',sourceId:null,note:null,durationMinutes:10,doneAt:now}],summary:'QA synthetic archive',updatedAt:now}});
   const config=await windows.invoke('get_config');config.tagColors['cloud-qa']='blue';config.candidate.missedRoutineGraceHours=6;await windows.invoke('set_config',{config});
   fixture={eventId:event.id,routineId:routine.id,longId:long.id,templateId:template.id,sessionId};published=await business(windows);
   const saved=published.longTasks.find(x=>x.id===long.id);assert.equal(saved.sessions.length,1);assert.equal(saved.sessions[0].durationMs,60000);
   assert.equal((await action(windows,'sync_now')).dirty,false);phoneLocalConfig=localConfig(await phone.invoke('get_config'));
 });
 await check('normal Windows exit releases lease',async()=>{await exit(windows);windows=null});
 await check('phone detects existing local data and preserves a recovery copy',async()=>{
   try{await action(phone,'sync_now')}catch{}
   const s=await phone.invoke('sync_get_status');assert.ok(s.needsInitialChoice);
   const previous=await phone.invoke('recovery_points');
   await action(phone,'sync_resolve_initial',{input:{choice:'download'}});
   phoneRestoreId=(await phone.invoke('recovery_points')).find(id=>!previous.includes(id));
   assert.ok(phoneRestoreId);
   assert.ok((await phone.invoke('load_all_data')).tasks.some(t=>t.id===task.id));
 });
 await check('phone receives identical IDs, deletion states, templates, sessions, archives and shared config while retaining device settings',async()=>{
   assert.equal(canonical(await business(phone)),canonical(published));assert.deepEqual(localConfig(await phone.invoke('get_config')),phoneLocalConfig);
 });
 await check('phone updates deletion tombstones, effective sessions, older archive and shared settings',async()=>{
   await phone.invoke('delete_event',{id:fixture.eventId});await phone.invoke('delete_routine',{id:fixture.routineId});await phone.invoke('delete_template',{id:fixture.templateId});
   await phone.invoke('delete_long_task_session',{input:{taskId:fixture.longId,sessionId:fixture.sessionId}});
   const end=Date.now();await phone.invoke('add_long_task_session',{input:{taskId:fixture.longId,startedAt:new Date(end-60000).toISOString(),endedAt:new Date(end).toISOString(),durationMs:30000,note:'QA phone effective half-minute',sessionId:'qa-cloud-phone-session-'+end}});
   await phone.invoke('update_archive_day',{date:'2025-01-15',payload:{entries:[],summary:'QA older archive cleared on phone',updatedAt:new Date().toISOString()}});
   const config=await phone.invoke('get_config');config.tagColors['cloud-qa']='red';config.candidate.missedRoutineGraceHours=8;await phone.invoke('set_config',{config});
 });
 await check('phone edit immediately followed by exit uploads latest content',async()=>{
   await phone.invoke('save_task',{task:{...task,title:'QA cloud Android roundtrip'}});
   returned=await business(phone);
   await exit(phone);phone=null;
 });
 await check('Windows restart downloads the phone edit without duplicating IDs',async()=>{
   windows=await restartWindows();
   await action(windows,'sync_now');
   const data=await windows.invoke('load_all_data');const matches=data.tasks.filter(t=>t.id===task.id);
   assert.equal(matches.length,1);assert.equal(matches[0].title,'QA cloud Android roundtrip');
   assert.equal((await windows.invoke('sync_get_status')).dirty,false);
 });
 await check('Windows receives the full phone result without resurrecting deletions or duplicating sessions',async()=>{
   const data=await business(windows);assert.equal(canonical(data),canonical(returned));
   assert.ok(data.events.find(x=>x.id===fixture.eventId).deletedAt);assert.ok(data.routines.find(x=>x.id===fixture.routineId).deletedAt);assert.ok(data.templates.find(x=>x.id===fixture.templateId).deletedAt);
   const sessions=data.longTasks.find(x=>x.id===fixture.longId).sessions;assert.equal(sessions.length,2);assert.ok(sessions.find(x=>x.id===fixture.sessionId).deletedAt);assert.equal(sessions.filter(x=>!x.deletedAt).reduce((sum,x)=>sum+x.durationMs,0),30000);
 });
 await check('finish with cloud leases released',async()=>{await action(windows,'sync_disconnect');await exit(windows);windows=null});
 await check('restore the phone pre-cloud data, verify every JSON hash and remove QA credentials',restorePhone);
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(async()=>{
 if(phonePrepared&&!phoneRestored){try{await restorePhone();results.push({name:'failure cleanup restored and verified the original phone data',passed:true})}catch(error){console.error('Phone cleanup needs review: '+String(error));results.push({name:'phone cleanup',passed:false,error:String(error)});process.exitCode=1}}
 if(windowsPrepared){
   try{
     if(!windows)windows=await restartWindows();
     if((await windows.invoke('sync_get_status')).configured)await action(windows,'sync_disconnect');
     const empty=path.join(root,'.build-cache/windows-evidence/cloud-empty');fs.mkdirSync(empty,{recursive:true});
     fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(windowsConfig));
     await windows.invoke('import_data',{srcDir:empty});assert.equal((await windows.invoke('load_all_data')).tasks.length,0);
     await exit(windows);windows=null;
   }catch(error){console.error('Windows QA cleanup needs review: '+String(error));process.exitCode=1}
 }
 if(windows)windows.close();if(phone)phone.close();
 fs.writeFileSync(path.join(out,windowsOnly?'windows-probe.json':'roundtrip.json'),JSON.stringify({recordedAt:new Date().toISOString(),prefix,mode:windowsOnly?'Windows only':'Windows and HONOR70',phoneOriginalDataVerified:phoneRestored,results,remoteData:'QA-only; retained for review'},null,2));
});
