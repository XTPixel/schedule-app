// Real Qiniu competition using two marked Windows QA processes, never real data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const{spawn}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.build-cache/windows-evidence'),out=path.join(root,'.build-cache/cloud-evidence');
const prefix=process.env.MOMENT_CLOUD_QA_PREFIX;assert.equal(prefix,'moment-qa/20261024-beta2-d43f80a3');
const exe=path.join(process.env.CARGO_TARGET_DIR,'debug/schedule-app.exe'),helper=path.join(process.env.CARGO_TARGET_DIR,'debug/examples/cloud_qa_credentials.exe');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];
const expiryMode=process.env.MOMENT_CLOUD_QA_EXPIRY==='1';let cancelRequested=false;
if(expiryMode){process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{if(value.includes('cancel'))cancelRequested=true});process.on('SIGINT',()=>{cancelRequested=true})}
const qaPortBase=Number(process.env.MOMENT_CLOUD_QA_PORT_BASE||9225);assert.ok([9225,9228].includes(qaPortBase));
const clients=[{port:qaPortBase,dir:path.join(base,'data'),name:'QA Windows A'},{port:qaPortBase+1,dir:path.join(base,'contender-data'),name:'QA Windows B'}];
async function connect(port){for(let n=0;n<40;n++){try{return await Client.connect(port)}catch{await wait(250)}}throw Error('QA bridge not ready: '+port)}
async function start(entry){
 fs.mkdirSync(entry.dir,{recursive:true});const marker=path.join(entry.dir,'.moment-qa-root');
 if(!fs.existsSync(marker))fs.writeFileSync(marker,'moment-isolated-test-data-v1');assert.equal(fs.readFileSync(marker,'utf8'),'moment-isolated-test-data-v1');
 const profile=path.join(base,'webview-'+entry.port),local=path.join(base,'local-'+entry.port);
 const child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:entry.dir,LOCALAPPDATA:local,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+entry.port}});child.unref();entry.pid=child.pid;entry.child=child;
 entry.client=await connect(entry.port);
 await entry.client.assertWindowsIsolation();
 // Pause the renderer's known five-second automatic sync interval before it
 // is created. Tauri's immutable invoke property cannot be monkey-patched.
 // Explicit sync_now still exercises the complete native production protocol.
 await entry.client.command('Page.addScriptToEvaluateOnNewDocument',{source:'(()=>{const original=window.setInterval;window.setInterval=(fn,ms,...args)=>original(ms===5000?()=>{}:fn,ms,...args)})()'});
 await entry.client.evaluate('location.reload();true');
 for(let n=0;n<40;n++){try{await entry.client.invoke('load_all_data');break}catch{await wait(100)}}
}
async function action(entry,name,args={}){let networkRetries=0;for(let n=0;n<180;n++){if((await entry.client.invoke('sync_get_status')).syncing){await wait(250);continue}try{return await entry.client.invoke(name,args)}catch(error){const text=String(error);if(text.includes('同步正在进行'))continue;if(/网络连接失败|七牛上传失败|同步提交发生竞争或网络失败/.test(text)&&networkRetries<3){await wait(1000*2**networkRetries++);continue}throw error}}throw Error('QA remained busy')}
async function exit(entry){try{await action(entry,'sync_exit')}catch(error){if(!/closed/.test(String(error)))throw error}entry.client.close();entry.client=null;await wait(400)}
async function check(name,work){const start=Date.now();try{await work();results.push({name,passed:true,ms:Date.now()-start});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function bootstrap(){
 const token=crypto.randomBytes(32).toString('hex');let configured=false;
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/bootstrap'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return}
  try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw Error('bootstrap too large')}const input=JSON.parse(raw);assert.equal(input.bucket,'moment-app');
   for(const entry of clients){assert.equal((await entry.client.invoke('sync_get_status')).configured,false);await action(entry,'sync_configure',{input:{...input,prefix,deviceName:entry.name}})}configured=true;res.writeHead(200);res.end('configured');
  }catch{res.writeHead(500);res.end('bootstrap failed')}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const child=spawn(helper,[],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,MOMENT_ALLOW_CLOUD_QA:'1',MOMENT_QA_BOOTSTRAP:'http://127.0.0.1:'+server.address().port+'/bootstrap',MOMENT_QA_TOKEN:token}});let safeError='';child.stderr.on('data',b=>safeError+=b);const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)});assert.ok(code===0&&configured,safeError.trim()||'Native bootstrap failed')}finally{server.close()}
}
async function main(){
 for(const entry of clients){await start(entry);const data=await entry.client.invoke('load_all_data');assert.equal(data.tasks.length+data.events.length+data.routines.length+data.longTasks.length,0);assert.equal((await entry.client.invoke('sync_get_status')).configured,false);entry.originalConfig=data.config;entry.prepared=true}
 await check('configure two isolated Windows QA clients without logging credentials',bootstrap);
 let winner,loser,task;
 await check('simultaneous real-cloud lease attempts have exactly one winner',async()=>{
  const outcomes=await Promise.allSettled(clients.map(entry=>action(entry,'sync_now')));const winners=outcomes.map((value,index)=>({value,index})).filter(x=>x.value.status==='fulfilled'&&x.value.value.editable);
  if(winners.length!==1){const categories=outcomes.map(value=>{const error=value.status==='rejected'?String(value.reason):value.value.lastError||'';return{fulfilled:value.status==='fulfilled',editable:value.status==='fulfilled'&&value.value.editable,transportKind:error.match(/\[(Dns|ConnectionFailed|BadStatus|BadHeader|Io|ProxyConnect|ProxyUnauthorized|InvalidProxyUrl|TooManyRedirects)\]/)?.[1]||null,categories:['竞争','首次同步','租约已过期','正在被','时钟','网络','版本','凭据','正在进行'].filter(word=>error.includes(word))}});fs.writeFileSync(path.join(out,'contention-attempts.json'),JSON.stringify(categories,null,2))}
  assert.equal(winners.length,1);
  winner=clients[winners[0].index];loser=clients[1-winners[0].index];assert.equal((await loser.client.invoke('sync_get_status')).editable,false);
 });
 await check('losing client cannot bypass read-only through native save IPC',async()=>{
  const now=new Date().toISOString();await assert.rejects(()=>loser.client.invoke('save_task',{task:{id:'',title:'QA forbidden edit',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}}));
 });
 await check('winning client publishes a new synthetic task',async()=>{
  const now=new Date().toISOString();task=await winner.client.invoke('save_task',{task:{id:'',title:'QA real cloud contention',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});assert.equal((await action(winner,'sync_now')).dirty,false);
 });
 await check('normal winner exit lets the other client acquire and download',async()=>{
  await exit(winner);assert.equal((await action(loser,'sync_now')).editable,true);const matches=(await loser.client.invoke('load_all_data')).tasks.filter(t=>t.id===task.id);assert.equal(matches.length,1);assert.equal(matches[0].title,task.title);
 });
 let day;
 await check('successor publishes deletion, archive and shared tag color',async()=>{
  await loser.client.invoke('delete_task',{id:task.id});day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());const now=new Date().toISOString();
  await loser.client.invoke('update_archive_day',{date:day,payload:{entries:[{id:'qa-cloud-archive-'+Date.now(),time:'12:00',title:'QA shared archive',source:'manual',sourceId:null,note:null,durationMinutes:10,doneAt:now}],summary:null,updatedAt:now}});
  const config=await loser.client.invoke('get_config');config.tagColors['cloud-qa']='red';await loser.client.invoke('set_config',{config});assert.equal((await action(loser,'sync_now')).dirty,false);await exit(loser);
 });
 await check('previous owner restarts and receives deletion without resurrecting IDs',async()=>{
  await start(winner);await action(winner,'sync_now');const data=await winner.client.invoke('load_all_data'),matches=data.tasks.filter(t=>t.id===task.id);assert.equal(matches.length,1);assert.ok(matches[0].deletedAt);assert.equal(data.config.tagColors['cloud-qa'],'red');
  const archive=await winner.client.invoke('get_archive_month',{month:day.slice(0,7)});assert.ok(archive.days[day].entries.some(e=>e.title==='QA shared archive'));
 });
 if(expiryMode){
  if(!loser.client)await start(loser);
  const held=JSON.parse(fs.readFileSync(path.join(winner.dir,'sync-state.json'),'utf8')).heldLease,expires=Date.parse(held.expiresAt),started=Date.now();
  assert.ok(expires>started+60000&&expires<started+31*60000,'Use the real production lease duration');
  await check('crashing the active owner leaves the real lease blocking the other client',async()=>{
   assert.equal(entryAlive(winner),true);assert.equal(winner.child.kill('SIGKILL'),true);winner.client.close();winner.client=null;await wait(1000);
   await assert.rejects(()=>action(loser,'sync_now'),/正在被/);assert.equal((await loser.client.invoke('sync_get_status')).editable,false);
  });
  await check('after the actual lease deadline the other client still requires explicit takeover',async()=>{
   fs.writeFileSync(path.join(out,'expiry-progress.json'),JSON.stringify({phase:'waiting-for-real-expiry',startedAt:new Date(started).toISOString(),leaseExpiresAt:new Date(expires).toISOString()},null,2));
   console.log('WAIT real production lease until '+new Date(expires).toISOString());
   while(Date.now()<expires+2000){if(cancelRequested)throw Error('QA expiry check cancelled; restoring isolated clients');await wait(Math.min(1000,expires+2000-Date.now()))}
   await assert.rejects(()=>action(loser,'sync_now'),/租约已过期/);assert.equal((await loser.client.invoke('sync_get_status')).editable,false);
  });
  await check('explicit takeover acquires the expired lease and preserves the downloaded tombstone',async()=>{
   assert.equal((await action(loser,'sync_takeover_expired')).editable,true);assert.ok((await loser.client.invoke('load_all_data')).tasks.find(t=>t.id===task.id).deletedAt);
  });
  await check('restarting the old owner cannot write with its expired token',async()=>{
   await start(winner);await assert.rejects(()=>action(winner,'sync_now'),/正在被/);assert.equal((await winner.client.invoke('sync_get_status')).editable,false);
   const now=new Date().toISOString();await assert.rejects(()=>winner.client.invoke('save_task',{task:{id:'',title:'QA old expired owner forbidden',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}}));
  });
  await check('the successor publishes once and the recovered old client receives the new revision',async()=>{
   const now=new Date().toISOString(),saved=await loser.client.invoke('save_task',{task:{id:'',title:'QA real expired takeover',description:null,priority:'normal',deadline:null,tags:['cloud-qa'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});
   assert.equal((await action(loser,'sync_now')).dirty,false);await exit(loser);assert.equal((await action(winner,'sync_now')).editable,true);
   const matches=(await winner.client.invoke('load_all_data')).tasks.filter(t=>t.id===saved.id);assert.equal(matches.length,1);assert.equal(matches[0].title,saved.title);
  });
  fs.writeFileSync(path.join(out,'expiry-progress.json'),JSON.stringify({phase:'passed',recordedAt:new Date().toISOString(),realElapsedMs:Date.now()-started,leaseExpiresAt:new Date(expires).toISOString()},null,2));
 }
}
function entryAlive(entry){return entry.child&&entry.child.exitCode===null&&entry.child.signalCode===null}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(async()=>{
 for(const entry of clients){if(!entry.prepared){if(entry.client)entry.client.close();continue}try{if(!entry.client)await start(entry);if((await entry.client.invoke('sync_get_status')).configured)await action(entry,'sync_disconnect');const empty=path.join(base,'contention-empty-'+entry.port);fs.mkdirSync(empty,{recursive:true});fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(entry.originalConfig));await action(entry,'import_data',{srcDir:empty});assert.equal((await entry.client.invoke('load_all_data')).tasks.length,0);await exit(entry)}catch(error){console.error('QA cleanup requires review for port '+entry.port+': '+String(error));process.exitCode=1;if(entry.client)entry.client.close()}}
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,expiryMode?'windows-expiry.json':'windows-contention.json'),JSON.stringify({recordedAt:new Date().toISOString(),prefix,platform:'two isolated Windows QA instances',realProductionLeaseExpiry:expiryMode,results,remoteData:'Synthetic QA only; retained for review'},null,2));
 if(expiryMode)process.stdin.pause();
});
