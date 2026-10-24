// Launch the real optimized EXE only on the explicitly authorized CI runner.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const{spawn,execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');assert.equal(process.env.MOMENT_ALLOW_INSTALLER_QA,'1');assert.equal(path.resolve(process.env.GITHUB_WORKSPACE),root);assert.match(root,/^D:\\/i);
const out=path.join(root,'.build-cache/windows-installer-evidence'),exe=path.join(process.env.CARGO_TARGET_DIR,'release/schedule-app.exe'),results=[];
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),wait=ms=>new Promise(r=>setTimeout(r,ms));let client,child,task,lastStartupError,stderr='',endpointPages=[];
let processDiagnostics;
function inspectProcess(){
 if(!child)return;
 const command='$p=Get-Process -Id '+child.pid+' -ErrorAction SilentlyContinue | Select-Object Id,Responding,MainWindowTitle,MainWindowHandle,SessionId,PrivateMemorySize64; $children=Get-CimInstance Win32_Process -Filter "ParentProcessId = '+child.pid+'" | Select-Object Name,ProcessId,ParentProcessId,CommandLine; $wv=Get-ChildItem -LiteralPath (Join-Path ([Environment]::GetEnvironmentVariable("ProgramFiles(x86)")) "Microsoft/EdgeWebView/Application") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name; @{process=$p;children=@($children);webViewVersions=@($wv)} | ConvertTo-Json -Depth 5 -Compress';
 try{processDiagnostics=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',timeout:15000}))}catch(e){processDiagnostics={inspectionError:String(e)}}
}
async function until(fn){for(let n=0;n<300;n++){try{if(await fn())return}catch(e){if(!/fetch failed|closed|Execution context was destroyed|undefined|owned application page required/.test(String(e)))throw e}await wait(200)}throw Error('CI Release window did not become ready; last error='+lastStartupError+'; exit='+child?.exitCode+'; stderr='+stderr)}
async function start(){
 fs.mkdirSync(out,{recursive:true});
 child=spawn(exe,[],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(out,'release-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225'}});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-4000)});child.stdout.resume();child.on('error',e=>{lastStartupError=String(e)});
 await until(async()=>{if(child.exitCode!==null)throw Error('Optimized process exited: '+child.exitCode+'; '+stderr);try{endpointPages=(await(await fetch('http://127.0.0.1:9225/json/list')).json()).map(x=>({type:x.type,url:x.url}));client=await Client.connect(9225);return true}catch(e){lastStartupError=String(e);return false}});
 assert.equal(await client.invoke('plugin:app|version'),version);assert.equal(await client.invoke('plugin:window|title',{label:'main'}),'此刻');assert.match(await client.evaluate('navigator.userAgent'),/Windows NT/);
 await until(()=>client.evaluate('Boolean(document.querySelector("main nav")||document.querySelector("nav button"))'));
 assert.equal((await client.invoke('sync_get_status')).configured,false);
}
async function close(){if(client){try{await client.invoke('sync_exit')}catch(e){if(!/closed/.test(String(e)))throw e}client.close();client=null}await until(async()=>child.exitCode!==null);assert.equal(child.exitCode,0)}
async function check(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name)}catch(e){results.push({name,passed:false,error:String(e)});throw e}}
async function main(){
 try{await fetch('http://127.0.0.1:9225/json/list');throw Error('CI QA port is occupied')}catch(e){if(/occupied/.test(String(e)))throw e}
 await check('optimized Release cold start loads its native version and real frontend',async()=>{
  await start();const data=await client.invoke('load_all_data');assert.equal(data.events.length+data.tasks.length+data.routines.length+data.longTasks.length,0,'Disposable CI account must have no business data');assert.match(await client.evaluate('document.body.innerText'),new RegExp(version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 });
 await check('optimized native save survives normal exit and a second process start',async()=>{
  const now=new Date().toISOString();task=await client.invoke('save_task',{task:{id:'',title:'QA optimized Windows release',description:null,tags:['qa-ci-release'],priority:'normal',createdAt:now,updatedAt:now,deletedAt:null,deadline:null,sortOrder:0,status:'active',completedAt:null}});await close();await start();assert.equal((await client.invoke('load_all_data')).tasks.find(x=>x.id===task.id)?.title,task.title);
 });
 await check('optimized frontend renders the restored item and native deletion succeeds',async()=>{
  await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("浮动")).click()');await until(()=>client.evaluate('document.querySelector("main").innerText.includes('+JSON.stringify(task.title)+')'));await client.invoke('delete_task',{id:task.id});assert.ok((await client.invoke('load_all_data')).tasks.find(x=>x.id===task.id)?.deletedAt);await close();
 });
}
main().catch(e=>{inspectProcess();console.error(String(e));process.exitCode=1}).finally(async()=>{if(client){try{await close()}catch(e){console.error(String(e));process.exitCode=1}}if(child&&child.exitCode===null)child.kill();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'release-runtime.json'),JSON.stringify({recordedAt:new Date().toISOString(),version,sourceCommit:process.env.GITHUB_SHA,disposableCiOnly:true,binarySha256,diagnostics:{lastStartupError,processExit:child?.exitCode,stderr,endpointPages,processDiagnostics},results},null,2))});
