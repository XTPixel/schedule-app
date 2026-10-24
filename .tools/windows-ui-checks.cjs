// Real React handlers + native IPC, restricted to the empty marked Windows QA instance.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{Client}=require('./webview-qa-client.cjs');
const base=path.resolve(__dirname,'../.build-cache/windows-evidence');let client,config,prepared=false;const results=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){for(let n=0;n<40;n++){if(await test())return;await wait(100)}throw Error('UI condition did not become ready')}
async function check(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function nav(text){await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes('+JSON.stringify(text)+')).click()')}
async function main(){
 assert.equal(fs.readFileSync(path.join(base,'data','.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');client=await Client.connect(9225);
 await client.assertWindowsIsolation();
 assert.equal((await client.invoke('sync_get_status')).configured,false);const data=await client.invoke('load_all_data');assert.equal(data.tasks.length+data.events.length+data.routines.length+data.longTasks.length,0);config=data.config;prepared=true;
 const inputHelper='window.__qaInput=(selector,value)=>{const e=document.querySelector(selector);if(!e)throw Error("input missing");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};true';
 const now=new Date().toISOString();let task;
 await check('BUG-14 clearing deadline through the drawer saves null',async()=>{
   task=await client.invoke('save_task',{task:{id:'',title:'QA UI deadline',description:null,priority:'normal',deadline:now,tags:['qa-ui'],status:'active',sortOrder:0,createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});
   // Native fixture setup bypasses the store. Reload instead of relying on the
   // app's deliberately deduplicated focus refresh between repeated test runs.
   await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke&&document.querySelector("nav button"))'));
   await client.evaluate(inputHelper);await nav('浮动');
   await until(()=>client.evaluate('document.querySelector("main").innerText.includes("QA UI deadline")'));
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="更多").click()');
   await until(()=>client.evaluate('Boolean(document.querySelector("input[type=date]"))'));
   await client.evaluate('window.__qaInput("input[type=date]","")');await wait(50);
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="保存").click()');
   await until(async()=>(await client.invoke('load_all_data')).tasks.find(x=>x.id===task.id).deadline===null);
 });
 await check('BUG-05/08/09 prior-month UI delete gives undo and only restores selected entry',async()=>{
   const date='2025-03-12',entry=id=>({id,time:'12:00',title:'QA UI '+id,source:'manual',sourceId:null,note:null,durationMinutes:10,doneAt:now});const a=entry('undo-a'),b=entry('undo-b');
   await client.invoke('update_archive_day',{date,payload:{entries:[a,b],summary:null,updatedAt:now}});await nav('归档');
   await until(()=>client.evaluate('Boolean(document.querySelector("main input[type=date]"))'));
   await client.evaluate('window.__qaInput("main input[type=date]",'+JSON.stringify(date)+')');
   await until(()=>client.evaluate('document.querySelector("main").innerText.includes("QA UI undo-a")'));
   async function remove(title){await client.evaluate('[...document.querySelectorAll("main li")].find(x=>x.innerText.includes('+JSON.stringify(title)+')).querySelector("button[title=删除记录]").click()');await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="确认").click()')}
   await remove(a.title);await until(async()=>!(await client.invoke('get_archive_month',{month:'2025-03'})).days[date].entries.some(x=>x.id===a.id));
   await until(()=>client.evaluate('document.body.innerText.includes("已删除记录")&&[...document.querySelectorAll("button")].some(x=>x.innerText==="撤回")'));
   await client.evaluate('window.__qaUndo=[...document.querySelectorAll("button")].filter(x=>x.innerText==="撤回").at(-1);true');
   await remove(b.title);await until(async()=>(await client.invoke('get_archive_month',{month:'2025-03'})).days[date].entries.length===0);
   await client.evaluate('window.__qaUndo.click()');await until(async()=>(await client.invoke('get_archive_month',{month:'2025-03'})).days[date].entries.length===1);
   assert.deepEqual((await client.invoke('get_archive_month',{month:'2025-03'})).days[date].entries.map(x=>x.id),[a.id]);
 });
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(async()=>{
 try{if(prepared){const empty=path.join(base,'ui-empty');fs.mkdirSync(empty,{recursive:true});fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(config));await client.invoke('import_data',{srcDir:empty});assert.equal((await client.invoke('load_all_data')).tasks.length,0)}}catch(error){console.error('QA cleanup: '+error);process.exitCode=1}
 if(client)client.close();fs.writeFileSync(path.join(base,'ui-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),results},null,2));
});
