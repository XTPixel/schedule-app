// Fault injection is restricted to the dedicated disposable emulator.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const {Client}=require('./webview-qa-client.cjs');
const serial=process.env.MOMENT_EMULATOR||'emulator-5554';assert.ok(serial.startsWith('emulator-'));
const qaPort=Number(process.env.MOMENT_ANDROID_QA_PORT||9223);assert.ok([9223,9227].includes(qaPort));
const root=path.resolve(__dirname,'..'),out=path.join(root,'.build-cache','android-evidence');
const adb=path.join(process.env.ANDROID_HOME,'platform-tools','adb.exe');
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let client;const results=[];let xmlSequence=0;
async function attach(){for(let n=0;n<30;n++){try{const pid=shell('shell','pidof','com.personal.schedule').trim();shell('forward','tcp:'+qaPort,'localabstract:webview_devtools_remote_'+pid);return await Client.connect(qaPort)}catch{await wait(400)}}throw Error('Emulator bridge not ready')}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function until(work){for(let n=0;n<60;n++){try{if(await client.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)')&&await work())return}catch(error){const text=String(error);if(!text.includes('Execution context was destroyed')&&!text.includes("Cannot read properties of undefined (reading 'invoke')"))throw error}await wait(100)}throw Error('Recovery UI condition not ready')}
async function navigationClick(expression){try{await client.evaluate(expression)}catch(error){if(!String(error).includes('Execution context was destroyed'))throw error}}
async function recoveryDocument(password){
 await client.evaluate('(()=>{const e=document.querySelector("input[aria-label=备份口令]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(password)+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()');await wait(30);
 await client.evaluate('[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="从备份文件恢复").click()');await until(()=>client.evaluate('Boolean(document.querySelector("[role=alertdialog]"))'));
 await client.evaluate('[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="确认恢复").click()');
}
async function corruptAndRestart(file,text){client.close();shell('shell','am','force-stop','com.personal.schedule');shell('shell','run-as','com.personal.schedule','sh','-c',"'printf "+text+' > '+file+"'");shell('shell','am','start','-n','com.personal.schedule/.MainActivity');client=await attach();await until(()=>client.evaluate('document.body.innerText.includes("需要恢复本地数据")'))}
function xml(){
 shell('shell','input','keyevent','KEYCODE_WAKEUP');
 const file='/sdcard/moment-picker-'+Date.now()+'-'+(++xmlSequence)+'.xml';
 const dumped=shell('shell','uiautomator','dump',file);
 if(!dumped.includes('dumped to:'))return [];
 const source=shell('shell','cat',file);shell('shell','rm','-f',file);
 const nodes=[...source.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));
 return nodes.filter(n=>n.package?.includes('documentsui'));
}
function tap(node){assert.ok(node,'Observed picker control missing');const p=node.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)))}
async function savePicker(){
 let nodes=[],field;
 for(let n=0;n<8;n++){nodes=xml();field=nodes.find(n=>n.class==='android.widget.EditText'&&n.text.endsWith('.json'));if(field)break;await wait(250)}
 assert.ok(field,'save picker did not become ready');const name=field.text;
 tap(nodes.find(n=>/^(SAVE|保存)$/.test(n.text)&&n.enabled==='true'));
 await wait(300);return name;
}
async function choosePicker(name){
 let selected;for(let n=0;n<8;n++){selected=xml().find(n=>n.text===name);if(selected)break;await wait(250)}
 tap(selected);await wait(250);
}
async function main(){
 await require('./emulator-system-ui-ready.cjs')(serial);
 shell('shell','input','keyevent','KEYCODE_WAKEUP');
 client=await attach();
 assert.equal((await client.invoke('sync_get_status')).configured,false);
 const before=await client.invoke('load_all_data');
 const event=before.events.find(e=>!e.deletedAt&&e.title.startsWith('QA-'));assert.ok(event);
 const password='qa-backup-passphrase-20261024';let name;
 await check('encrypted backup through native SAF contains no cleartext titles',async()=>{
   await client.evaluate('window.__nativeExport=window.__TAURI_INTERNALS__.invoke("export_backup_document",{passphrase:'+JSON.stringify(password)+'});true');
   name=await savePicker();assert.equal(await client.evaluate('window.__nativeExport'),true);
   const raw=shell('exec-out','cat','/sdcard/Download/'+name);const encoded=JSON.parse(raw);
   assert.equal(encoded.format,'moment-sync-v1');assert.equal(raw.includes(event.title),false);
   fs.writeFileSync(path.join(out,'encrypted-backup.json'),raw);
 });
 await check('wrong backup password rejects without changing data',async()=>{
   await client.evaluate('window.__wrongImport=window.__TAURI_INTERNALS__.invoke("import_backup_document",{passphrase:"wrong-password"}).then(()=>"unexpected",e=>String(e));true');
   await choosePicker(name);assert.match(await client.evaluate('window.__wrongImport'),/口令错误|篡改/);
   assert.equal(JSON.stringify((await client.invoke('load_all_data')).events),JSON.stringify(before.events));
 });
 await check('encrypted backup restores data and creates local recovery point',async()=>{
   await client.invoke('save_event',{event:{...event,title:event.title+'-changed'}});
   await client.evaluate('window.__goodImport=window.__TAURI_INTERNALS__.invoke("import_backup_document",{passphrase:'+JSON.stringify(password)+'});true');
   await choosePicker(name);assert.equal(await client.evaluate('window.__goodImport'),true);
   assert.equal((await client.invoke('load_all_data')).events.find(e=>e.id===event.id).title,event.title);
   assert.ok((await client.invoke('recovery_points')).length>0);
 });
 await check('corrupt transaction journal opens recovery UI and blocks mutations',async()=>{
   client.close();shell('shell','am','force-stop','com.personal.schedule');
   shell('shell','run-as','com.personal.schedule','sh','-c',"'printf corrupted > .sync-transaction.json'");
   assert.equal(shell('shell','run-as','com.personal.schedule','cat','.sync-transaction.json'),'corrupted');
   shell('shell','am','start','-n','com.personal.schedule/.MainActivity');client=await attach();await wait(700);
   assert.match(await client.evaluate('document.body.innerText'),/需要恢复本地数据/);
   await assert.rejects(()=>client.invoke('save_event',{event:{...event,title:'must-not-save'}}));
 });
 await check('validated recovery point returns the application to normal',async()=>{
   const state=await client.invoke('recovery_status');assert.ok(state.error&&state.points.length);
   await client.invoke('restore_recovery_point',{id:state.points[0]});
   await client.evaluate('location.reload();true');await wait(700);
   assert.equal((await client.invoke('recovery_status')).error,null);
   assert.ok((await client.invoke('load_all_data')).events.length>0);
   assert.equal((await client.invoke('sync_get_status')).editable,true);
 });
 await check('ordinary business JSON corruption opens recovery and rejects native edits',async()=>{
   await corruptAndRestart('events.json','broken-business');const state=await client.invoke('recovery_status');assert.ok(state.error&&state.points.length);
   assert.equal(shell('exec-out','run-as','com.personal.schedule','cat','events.json'),'broken-business');
   await assert.rejects(()=>client.invoke('save_event',{event:{...event,title:'must-not-overwrite-corrupt-data'}}));
 });
 await check('local recovery completes through the visible inline confirmation',async()=>{
   await client.evaluate('[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="恢复所选副本").click()');await until(()=>client.evaluate('Boolean(document.querySelector("[role=alertdialog]"))'));
   await navigationClick('[...document.querySelectorAll("button")].find(e=>e.innerText.trim()==="确认恢复").click()');
   await until(async()=>(await client.invoke('recovery_status')).error===null);await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));
   assert.ok((await client.invoke('load_all_data')).events.some(e=>e.id===event.id));
 });
 await check('cancelling the file picker preserves corrupted config and the blocked state',async()=>{
   await corruptAndRestart('config.json','broken-config');await recoveryDocument(password);
   for(let n=0;n<8;n++){if(xml().length)break;await wait(250)}shell('shell','input','keyevent','KEYCODE_BACK');
   await until(()=>client.evaluate('document.body.innerText.includes("已取消文件恢复")'));assert.ok((await client.invoke('recovery_status')).error);
   assert.equal(shell('exec-out','run-as','com.personal.schedule','cat','config.json'),'broken-config');
 });
 await check('wrong encrypted backup password leaves recovery data and error state unchanged',async()=>{
   await recoveryDocument('wrong-password');await choosePicker(name);await until(()=>client.evaluate('/口令错误|篡改/.test(document.body.innerText)'));
   assert.ok((await client.invoke('recovery_status')).error);assert.equal(shell('exec-out','run-as','com.personal.schedule','cat','config.json'),'broken-config');
 });
 await check('encrypted document recovery works without readable config and retains the damaged original',async()=>{
   await recoveryDocument(password);await choosePicker(name);await until(async()=>(await client.invoke('recovery_status')).error===null);await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));
   assert.ok((await client.invoke('load_all_data')).events.some(e=>e.id===event.id));
   const points=await client.invoke('recovery_points');assert.ok(points.some(id=>{assert.match(id,/^[a-zA-Z0-9-]+$/);return shell('exec-out','run-as','com.personal.schedule','cat','.sync-recovery/'+id+'/config.json')==='broken-config'}));
 });
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(()=>{
 if(client)client.close();fs.writeFileSync(path.join(out,'recovery-checks.json'),JSON.stringify({recordedAt:new Date().toISOString(),serial,results},null,2));
});
