// Real WM_CLOSE against owned, explicitly marked Windows QA processes only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{spawn,execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const out=path.join(root,'.build-cache/windows-lifecycle',version+'-'+Date.now()),dir=path.join(out,'data');
const wait=ms=>new Promise(r=>setTimeout(r,ms));let client,child,owned=false;const results=[];
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.moment-qa-root'),'moment-isolated-test-data-v1');
const exe=path.join(out,'schedule-app.exe');fs.copyFileSync(path.join(process.env.CARGO_TARGET_DIR,'debug/schedule-app.exe'),exe);
async function until(fn){for(let n=0;n<100;n++){if(await fn())return;await wait(100)}throw Error('Owned Windows lifecycle state did not become ready')}
async function check(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name)}catch(e){results.push({name,passed:false,error:String(e)});throw e}}
async function start(){
 owned=false;child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:dir,APPDATA:path.join(out,'roaming'),LOCALAPPDATA:path.join(out,'local'),WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225'}});
 await until(async()=>{try{client=await Client.connect(9225);await client.assertWindowsIsolation();owned=true;return true}catch{if(client)client.close();return false}});
 assert.equal((await client.invoke('sync_get_status')).configured,false);
}
function nativeClose(){
 assert.ok(owned&&child&&child.exitCode===null,'Refusing to close an unverified process');
 const result=execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${child.pid}; if($p.MainWindowHandle -eq 0){throw 'Owned main window unavailable'}; if(-not $p.CloseMainWindow()){throw 'Owned WM_CLOSE failed'}`],{encoding:'utf8',timeout:15000});return result;
}
async function main(){
 try{await fetch('http://127.0.0.1:9225/json/list');throw Error('QA port 9225 is occupied')}catch(e){if(/occupied/.test(String(e)))throw e}
 await start();let data=await client.invoke('load_all_data');
 await check('WM_CLOSE hides the marked window when minimize-to-tray is enabled',async()=>{
  await client.invoke('set_config',{config:{...data.config,behavior:{...data.config.behavior,minimizeToTray:true}}});
  nativeClose();await until(async()=>!(await client.invoke('plugin:window|is_visible',{label:'main'})));assert.equal(child.exitCode,null);
 });
 await check('hidden local-only process exits through the normal sync-exit command',async()=>{
  try{await client.invoke('sync_exit')}catch(e){if(!/closed/.test(String(e)))throw e}
  await until(async()=>child.exitCode!==null);assert.equal(child.exitCode,0);client.close();client=null;
 });
 await start();data=await client.invoke('load_all_data');let task;
 await check('WM_CLOSE follows the frontend exit request when minimize-to-tray is disabled',async()=>{
  await client.invoke('set_config',{config:{...data.config,behavior:{...data.config.behavior,minimizeToTray:false}}});
  const now=new Date().toISOString();task=await client.invoke('save_task',{task:{id:'',title:'QA final edit before WM_CLOSE',description:null,tags:['qa-lifecycle'],priority:'normal',createdAt:now,updatedAt:now,deletedAt:null,deadline:null,sortOrder:0,status:'active',completedAt:null}});
  nativeClose();await until(async()=>child.exitCode!==null);assert.equal(child.exitCode,0);client.close();client=null;
 });
 await check('reopening preserves the last native write and the selected close behavior',async()=>{
  await start();const restored=await client.invoke('load_all_data');assert.equal(restored.tasks.find(x=>x.id===task.id).title,task.title);assert.equal(restored.config.behavior.minimizeToTray,false);
  await client.invoke('delete_task',{id:task.id});
 });
}
main().catch(e=>{console.error(String(e));process.exitCode=1}).finally(async()=>{if(client&&owned){try{await client.invoke('sync_exit')}catch(e){if(!/closed/.test(String(e))){console.error(String(e));process.exitCode=1}}client.close()}if(child&&child.exitCode===null){await wait(1000);if(child.exitCode===null)child.kill()}const record={recordedAt:new Date().toISOString(),version,results};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(record,null,2));fs.writeFileSync(path.join(root,'.build-cache/windows-lifecycle/latest.json'),JSON.stringify(record,null,2))});
