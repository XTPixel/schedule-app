// Additional historical UI regressions in the marked empty Windows QA profile.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{spawn}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.build-cache/windows-evidence'),dir=path.join(base,'data');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];let client,original,prepared=false;
async function until(test,label='UI'){for(let n=0;n<50;n++){if(await test())return;await wait(100)}throw Error('Expected UI state did not become ready: '+label)}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function nav(label){await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes('+JSON.stringify(label)+')).click()')}
async function main(){
 assert.equal(fs.readFileSync(path.join(dir,'.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');
 const launch=()=>spawn(path.join(process.env.CARGO_TARGET_DIR,'debug/schedule-app.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:dir,APPDATA:path.join(base,'roaming'),LOCALAPPDATA:path.join(base,'local'),WEBVIEW2_USER_DATA_FOLDER:path.join(base,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225'}});let child=launch();child.unref();
 for(let n=0;n<40;n++){try{client=await Client.connect(9225);break}catch{await wait(250)}}assert.ok(client);
 await client.assertWindowsIsolation();
 assert.equal((await client.invoke('sync_get_status')).configured,false);original=await client.invoke('load_all_data');assert.equal(original.events.length+original.tasks.length+original.routines.length+original.longTasks.length,0);prepared=true;
 const now=new Date().toISOString(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 const long=await client.invoke('save_long_task',{task:{id:'',title:'QA unsaved draft',description:null,priority:'normal',tags:['qa-ui-followup'],createdAt:now,updatedAt:now,deletedAt:null,startDate:day,dueDate:day,status:'active',endedAt:null,sessions:[]}});
 const end=Date.now();await client.invoke('add_long_task_session',{input:{taskId:long.id,startedAt:new Date(end-120000).toISOString(),endedAt:new Date(end).toISOString(),durationMs:60000,note:'QA session',sessionId:'qa-ui-session'}});
 await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));
 await client.evaluate('window.__qaInput=(selector,value)=>{const e=document.querySelector(selector);if(!e)throw Error("input missing");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};true');
 await check('BUG-17 returning to statistics after manual archive shows the native count',async()=>{
   await nav('统计');await until(()=>client.evaluate('document.querySelector("main").innerText.includes("完成事项")'),'stats chart');
   await nav('归档');await until(()=>client.evaluate('Boolean(document.querySelector("input[placeholder=标题]"))'),'archive input');
   await client.evaluate('window.__qaInput("input[placeholder=标题]","QA manual stats refresh")');await wait(30);
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="添加").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("已添加记录")'),'manual archive saved');
   const expected=(await client.invoke('get_stats',{days:30})).totals.completedCount;
   await nav('统计');await until(async()=>Number(await client.evaluate('[...document.querySelectorAll("main div")].find(x=>x.innerText==="完成事项").nextElementSibling.innerText'))===expected,'updated stats card');
 });
 await check('BUG-19 invalid inline due date restores the actual persisted date',async()=>{
   await nav('长期');await until(()=>client.evaluate('document.querySelectorAll("main input[type=date]").length>=2'));
   // Date inputs have separate wrappers; select the last owned page date input.
   await client.evaluate('window.__qaDue=[...document.querySelectorAll("main input[type=date]")].at(-1);window.__qaDue.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(window.__qaDue,"2000-01-01");window.__qaDue.dispatchEvent(new Event("input",{bubbles:true}));window.__qaDue.dispatchEvent(new Event("change",{bubbles:true}));true');await wait(200);
   await client.evaluate('window.__qaDue.blur();true');
   await until(()=>client.evaluate('document.body.innerText.includes("截止日期不能早于开始日期")'));
   assert.equal(await client.evaluate('window.__qaDue.value'),day);assert.equal((await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id).dueDate,day);
 });
 await check('BUG-18 updating a session note preserves the unsaved title and still asks before discarding it',async()=>{
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="详情").click()');await until(()=>client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))'));
   await client.evaluate('window.__qaInput("input[placeholder=输入标题]","QA title not saved")');await wait(30);
   await client.evaluate('[...document.querySelectorAll("li button[title=点击编辑]")].find(x=>x.innerText.trim()==="QA session").click()');
   const noteInput=JSON.stringify('input[placeholder="补填本次收获（可选）"]');
   await until(()=>client.evaluate(`Boolean(document.querySelector(${noteInput}))`));
   await client.evaluate(`window.__qaInput(${noteInput},"QA note saved")`);await wait(30);
   await client.evaluate(`document.querySelector(${noteInput}).blur();true`);
   await until(async()=>(await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id).sessions[0].note==='QA note saved','session note persisted');
   await wait(250);
   assert.equal(await client.evaluate('document.querySelector("input[placeholder=输入标题]").value'),'QA title not saved');
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="✕").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("放弃修改？")'),'unsaved draft confirmation');
   await client.evaluate('[...document.querySelectorAll("button")].filter(x=>x.innerText.trim()==="取消").at(-1).click()');
   await until(()=>client.evaluate('!document.body.innerText.includes("放弃修改？")'),'confirmation cancelled');
   assert.equal(await client.evaluate('document.querySelector("input[placeholder=输入标题]").value'),'QA title not saved');
 });
 await check('BUG-18 deleting and undoing a session preserve the unsaved title and close confirmation',async()=>{
   await client.evaluate('[...document.querySelectorAll("ol li button")].find(x=>x.innerText.trim()==="删除").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("删除本次记录")'),'session delete confirmation');
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="确认").click()');
   await until(async()=>Boolean((await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id).sessions[0].deletedAt),'session soft deletion');
   await until(()=>client.evaluate('document.body.innerText.includes("还没有投入记录")'),'empty session list');
   assert.equal(await client.evaluate('document.querySelector("input[placeholder=输入标题]").value'),'QA title not saved');
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="撤回").click()');
   await until(async()=>(await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id).sessions[0].deletedAt==null,'session restored');
   await until(()=>client.evaluate('Boolean([...document.querySelectorAll("ol li button")].find(x=>x.innerText.trim()==="QA note saved"))'),'restored session note');
   await wait(250);
   assert.equal(await client.evaluate('document.querySelector("input[placeholder=输入标题]").value'),'QA title not saved');
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="✕").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("放弃修改？")'),'close confirmation after undo');
   await client.evaluate('[...document.querySelectorAll("button")].filter(x=>x.innerText.trim()==="取消").at(-1).click()');
   await until(()=>client.evaluate('!document.body.innerText.includes("放弃修改？")'),'confirmation cancelled after undo');
   assert.equal(await client.evaluate('document.querySelector("input[placeholder=输入标题]").value'),'QA title not saved');
 });
 await check('BUG-23 inverted search dates show an error and corrected dates return matching data',async()=>{
   // Discard the deliberately unsaved draft after its protection was verified.
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="✕").click()');await until(()=>client.evaluate('document.body.innerText.includes("放弃修改？")'));
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="确认").click()');
   await nav('搜索');await until(()=>client.evaluate('Boolean(document.querySelector("input[aria-label=开始日期]"))'));
   await client.evaluate('window.__qaInput("input[aria-label=开始日期]","2026-12-31");window.__qaInput("input[aria-label=结束日期]","2026-01-01")');await wait(30);
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="搜索").click()');
   await until(()=>client.evaluate('document.querySelector("[role=alert]")?.innerText==="开始日期不能晚于结束日期"'));
   await client.evaluate('window.__qaInput("input[aria-label=开始日期]","2026-01-01");window.__qaInput("input[aria-label=结束日期]","2026-12-31")');await wait(30);
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="搜索").click()');
   await until(()=>client.evaluate('document.querySelector("main").innerText.includes("QA unsaved draft")'));
   assert.equal(await client.evaluate('Boolean(document.querySelector("[role=alert]"))'),false);
 });
 await check('deleting a floating item refreshes its list and offers a working undo',async()=>{
   await nav('浮动');await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.includes("新建浮动事项")).click()');
   await until(()=>client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))'));
   await client.evaluate('window.__qaInput("input[placeholder=输入标题]","QA void deletion")');await wait(30);
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="保存").click()');
   await until(()=>client.evaluate('!document.querySelector("input[placeholder=输入标题]")'));
   const task=(await client.invoke('load_all_data')).tasks.find(t=>t.title==='QA void deletion');assert.ok(task);
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="更多").click()');
   await until(()=>client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))'));
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="删除").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("删除浮动事项")'));
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="确认").click()');
   await until(()=>client.evaluate('document.querySelector("main").innerText.includes("暂无浮动事项")'));
   assert.ok((await client.invoke('load_all_data')).tasks.find(t=>t.id===task.id).deletedAt);
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="撤回").click()');
   await until(()=>client.evaluate('document.querySelector("main").innerText.includes("QA void deletion")'));
   assert.equal((await client.invoke('load_all_data')).tasks.find(t=>t.id===task.id).deletedAt,null);
 });
 await check('template deletion refreshes both the template editor and success message',async()=>{
   await nav('扩展');await until(()=>client.evaluate('document.body.innerText.includes("新建自定义模板")'));
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="新建自定义模板").click()');
   await until(()=>client.evaluate('document.querySelectorAll("input[placeholder=模板名称]").length===1'));
   const template=(await client.invoke('list_templates')).find(t=>!t.deletedAt);assert.ok(template);
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="删除").click()');
   await until(()=>client.evaluate('document.querySelectorAll("input[placeholder=模板名称]").length===0&&document.body.innerText.includes("已删除模板")'));
   assert.ok((await client.invoke('list_templates')).find(t=>t.id===template.id).deletedAt);
 });
 await check('BUG-03 an overnight paused timer records effective time and refreshes statistics',async()=>{
   const saved=(await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id);await client.invoke('save_long_task',{task:{...saved,startDate:new Date(Date.now()-2*86400000).toISOString().slice(0,10)}});
   const timers={[long.id]:{sourceType:'longtask',title:long.title,startedAt:0,accumulatedMs:3600000,running:false,sessionStartedAt:Date.now()-26*3600000,sessionId:'qa-overnight-paused'}};
   await client.evaluate('(()=>{const timers='+JSON.stringify(timers)+';localStorage.setItem("schedule.timers.v1",JSON.stringify(timers));localStorage.setItem("schedule.timers.checkpoint.v2",JSON.stringify({updatedAt:Date.now()+1,timers}));location.reload()})()');
   await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));await nav('统计');await until(()=>client.evaluate('document.querySelector("main").innerText.includes("总耗时")'));await nav('现在');
   await until(()=>client.evaluate('[...document.querySelectorAll("main button")].some(x=>x.innerText.trim()==="终止")'));
   await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="终止").click()');
   await until(()=>client.evaluate('document.body.innerText.includes("本次收获")'));
   const session=(await client.invoke('load_all_data')).longTasks.find(x=>x.id===long.id).sessions.find(x=>x.id==='qa-overnight-paused');assert.equal(session.durationMs,3600000);assert.ok(Date.parse(session.endedAt)-Date.parse(session.startedAt)>25*3600000);
   await client.evaluate('[...document.querySelectorAll("button")].filter(x=>x.innerText.trim()==="跳过").at(-1).click()');await nav('统计');
   const expected=(await client.invoke('get_stats',{days:30})).totals.durationMinutes;
   await until(()=>client.evaluate('Boolean([...document.querySelectorAll("main div")].find(x=>x.innerText==="总耗时"))'));
   assert.ok((await client.evaluate('[...document.querySelectorAll("main div")].find(x=>x.innerText==="总耗时").nextElementSibling.innerText')).includes(String(Math.floor(expected/60))+' 小时'));
 });
 await check('active timer checkpoint survives forced process termination and restores paused',async()=>{
   await nav('现在');const card='[...document.querySelectorAll("main h3")].find(x=>x.innerText==='+JSON.stringify(long.title)+').closest("div.rounded-2xl")';
   await client.evaluate('[...('+card+').querySelectorAll("button")].find(x=>x.innerText.trim()==="开始").click()');await wait(11500);
   const before=await client.evaluate('JSON.parse(localStorage.getItem("schedule.timers.v1"))['+JSON.stringify(long.id)+']');assert.equal(before.running,true);assert.ok(before.accumulatedMs>=9000);
   client.close();client=null;child.kill();await wait(1500);child=launch();child.unref();
   for(let n=0;n<60;n++){try{client=await Client.connect(9225);if(await client.evaluate('Boolean(document.querySelector("main"))'))break}catch{}await wait(200)}assert.ok(client);
   await until(()=>client.evaluate('[...document.querySelectorAll("main button")].some(x=>x.innerText.trim()==="继续")'));
   const restored=await client.evaluate('JSON.parse(localStorage.getItem("schedule.timers.v1"))['+JSON.stringify(long.id)+']');assert.equal(restored.running,false);assert.equal(restored.startedAt,0);assert.ok(restored.accumulatedMs>=before.accumulatedMs&&restored.accumulatedMs<before.accumulatedMs+3000);
 });
 await check('BUG-20 simultaneous external-change prompts keep both operations resolvable',async()=>{
   await client.evaluate('localStorage.removeItem("schedule.timers.v1");localStorage.removeItem("schedule.timers.checkpoint.v2");true');
   const common={id:'',description:null,tags:['qa-external-queue'],priority:'high',deadline:null,sortOrder:0,status:'active',createdAt:now,updatedAt:now,completedAt:null,deletedAt:null};
   const a=await client.invoke('save_task',{task:{...common,title:'QA external first'}}),b=await client.invoke('save_task',{task:{...common,title:'QA external second'}});
   await client.evaluate('location.reload();true');await until(()=>client.evaluate('document.querySelector("main")?.innerText.includes("QA external second")'));
   const filename=path.join(dir,'tasks.json'),changed=JSON.parse(fs.readFileSync(filename,'utf8'));for(const x of changed.tasks)if(x.id===a.id||x.id===b.id)x.description='External synthetic edit';await wait(30);fs.writeFileSync(filename,JSON.stringify(changed));
   await client.evaluate('(()=>{for(const title of ["QA external first","QA external second"]){const card=[...document.querySelectorAll("main h3")].find(x=>x.innerText===title).closest("div.rounded-2xl");[...card.querySelectorAll("button")].find(x=>x.innerText.trim()==="完成").click()}})()');
   await until(()=>client.evaluate('document.body.innerText.includes("数据文件被外部修改")'));await wait(300);
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.includes("重新加载（放弃本地修改）")).click()');await wait(300);
   await until(()=>client.evaluate('document.body.innerText.includes("数据文件被外部修改")'));
   await client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="覆盖外部改动").click()');
   await until(async()=>(await client.invoke('load_all_data')).tasks.filter(x=>x.id===a.id||x.id===b.id).filter(x=>x.status==='completed').length===1);
   const tasks=(await client.invoke('load_all_data')).tasks.filter(x=>x.id===a.id||x.id===b.id);assert.equal(tasks.filter(x=>x.status==='active').length,1);assert.ok(tasks.every(x=>x.description==='External synthetic edit'));assert.equal(await client.evaluate('document.body.innerText.includes("数据文件被外部修改")'),false);
 });
 await check('BUG-24 natural-language upper boundary saves and overflow opens an unsaved form',async()=>{
   await nav('现在');await client.evaluate('(()=>{const e=document.querySelector("input[placeholder^=快速新增]");e.value="3660天后QA-boundary";e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))})()');
   await until(async()=>(await client.invoke('load_all_data')).events.some(x=>x.title==='QA-boundary'));
   const before=(await client.invoke('load_all_data')).events.length;
   await client.evaluate('(()=>{const e=document.querySelector("input[placeholder^=快速新增]");e.value="3661天后QA-overflow";e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))})()');
   await until(()=>client.evaluate('document.querySelector("input[placeholder=输入标题]")?.value==="3661天后QA-overflow"'));assert.equal((await client.invoke('load_all_data')).events.length,before);
 });
}
main().catch(async error=>{console.error(String(error));if(client&&prepared){fs.writeFileSync(path.join(base,'followup-failure.txt'),await client.evaluate('document.body.innerText'));}process.exitCode=1}).finally(async()=>{
 if(prepared){try{const empty=path.join(base,'followup-empty');fs.mkdirSync(empty,{recursive:true});fs.writeFileSync(path.join(empty,'config.json'),JSON.stringify(original.config));await client.invoke('import_data',{srcDir:empty});assert.equal((await client.invoke('load_all_data')).longTasks.length,0)}catch(error){console.error('QA cleanup: '+String(error));process.exitCode=1}}
 if(client){try{await client.invoke('sync_exit')}catch(error){if(!/closed/.test(String(error))){console.error('QA exit: '+String(error));process.exitCode=1}}client.close()}
 fs.writeFileSync(path.join(base,'followup-ui-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),results},null,2));
});
