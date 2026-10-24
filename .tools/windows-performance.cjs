// Local performance fixture. Requires the explicit marked Windows QA directory.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.build-cache','windows-evidence');
async function main(){
 assert.equal(fs.readFileSync(path.join(base,'data','.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');
 let client;for(let n=0;n<30;n++){try{client=await Client.connect(9225);break}catch{await new Promise(r=>setTimeout(r,300))}}assert.ok(client,'Windows QA bridge did not become ready');let original,prepared=false;
 try{
   await client.assertWindowsIsolation();
   assert.equal((await client.invoke('sync_get_status')).configured,false);
   original=await client.invoke('load_all_data');assert.equal(original.tasks.length+original.events.length+original.longTasks.length,0);
   const large=path.join(base,'large-fixture'),empty=path.join(base,'empty-fixture');fs.mkdirSync(path.join(large,'archive'),{recursive:true});fs.mkdirSync(empty,{recursive:true});
   fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(original.config));
   prepared=true;
   const now=new Date().toISOString(),tasks=Array.from({length:10000},(_,n)=>({id:'qa-perf-'+n,title:'QA benchmark '+n,description:null,priority:'normal',deadline:null,tags:['qa-performance'],status:'active',sortOrder:n,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}));
   fs.writeFileSync(path.join(large,'config.json'),JSON.stringify({...original.config,notifications:{...original.config.notifications,enabled:false}}));fs.writeFileSync(path.join(large,'tasks.json'),JSON.stringify({version:6,tasks}));
   for(let n=0;n<24;n++){
     const at=new Date(Date.UTC(2024,10+n,1,4)),month=at.toISOString().slice(0,7),day=at.toISOString().slice(0,10);
     const entries=Array.from({length:100},(_,i)=>({id:'qa-perf-archive-'+n+'-'+i,time:'12:00',title:'QA benchmark archive',source:'manual',sourceId:null,note:null,durationMinutes:10,doneAt:at.toISOString()}));
     fs.writeFileSync(path.join(large,'archive',month+'.json'),JSON.stringify({version:6,month,days:{[day]:{entries,summary:null,updatedAt:now}}}));
   }
   const start=performance.now();const imported=await client.invoke('import_data',{srcDir:large});const importMs=performance.now()-start;
   assert.equal(imported.tasks,10000);assert.equal(imported.archiveMonths,24);
   const writes=[];for(let n=0;n<20;n++){const started=performance.now();await client.invoke('save_task',{task:{...tasks[0],title:'QA benchmark write '+n}});writes.push(performance.now()-started)}
   const candidateStart=performance.now();await client.invoke('get_now_candidates',{now});const candidatesMs=performance.now()-candidateStart;
   const statsStart=performance.now();await client.invoke('get_stats',{days:730});const statsMs=performance.now()-statsStart;
   writes.sort((a,b)=>a-b);const report={recordedAt:new Date().toISOString(),items:10000,archiveMonths:24,archiveEntries:2400,writeSamples:writes.length,writeP95Ms:writes[Math.ceil(writes.length*.95)-1],importMs,candidatesMs,statsMs,condition:process.env.MOMENT_PERF_CONDITION||'Windows isolated Debug process; schedule-core opt-level=2'};
   fs.writeFileSync(path.join(base,'performance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{
   if(prepared){await client.invoke('import_data',{srcDir:path.join(base,'empty-fixture')});assert.equal((await client.invoke('load_all_data')).tasks.length,0)}
   client.close();
 }
}
main().catch(error=>{console.error(String(error));process.exitCode=1});
