// Exercise real system picker URIs from the emulator-only fault provider.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),serial='emulator-5554',pkg='com.personal.schedule',port=9227;
const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),out=path.join(root,'.build-cache/android-evidence');
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];let client,before,sequence=0;
function nodes(){
 const file='/sdcard/moment-saf-'+(++sequence)+'.xml';assert.match(shell('shell','uiautomator','dump',file),/dumped to:/);
 const xml=shell('shell','cat',file);shell('shell','rm','-f',file);
 return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));
}
async function find(test){for(let n=0;n<20;n++){const value=nodes().find(test);if(value)return value;await wait(300)}throw Error('Expected SAF control not visible: '+test)}
function tap(node){const b=node.bounds.match(/\d+/g).map(Number);assert.ok(b[2]>b[0]&&b[3]>b[1]);shell('shell','input','tap',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)))}
async function attach(){shell('shell','am','start','-W','-n',pkg+'/.MomentLauncherActivity');for(let n=0;n<50;n++){try{const pid=shell('shell','pidof',pkg).trim();assert.match(pid,/^\d+$/);shell('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+pid);client=await Client.connect(port);return}catch{await wait(200)}}throw Error('Owned emulator bridge unavailable')}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('PASS '+name)}catch(e){results.push({name,passed:false,error:String(e)});throw e}}
async function until(work){for(let n=0;n<100;n++){if(await work())return;await wait(100)}throw Error('Expected backup UI result did not appear')}
const exportClick=()=>client.evaluate('[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="导出备份"&&!x.disabled).click()');
async function cancelPicker(){for(let n=0;n<6;n++){const resumed=shell('shell','dumpsys','activity','activities').split('\n').filter(x=>/topResumedActivity|mResumedActivity/.test(x));if(!resumed.some(x=>x.includes('documentsui')))return;shell('shell','input','keyevent','KEYCODE_BACK');await wait(200)}throw Error('Owned document picker did not close')}
async function pickFault(folder){
 tap(await find(n=>n.package?.includes('documentsui')&&/Show roots|Open navigation drawer|显示根目录|打开导航/.test(n['content-desc']||'')));
 tap(await find(n=>n.package?.includes('documentsui')&&n['resource-id']==='android:id/title'&&n.text==='MOMENT SAF QA'));
 tap(await find(n=>n.package?.includes('documentsui')&&n['resource-id']==='android:id/title'&&n.text===folder));
 await find(n=>n.package?.includes('documentsui')&&n.class==='android.widget.EditText'&&n.text.endsWith('.json'));
 tap(await find(n=>n.package?.includes('documentsui')&&/^(SAVE|保存)$/.test(n.text)&&n.enabled==='true'));
}
async function main(){
 assert.equal(shell('emu','avd','name').trim().split(/\s+/)[0],'Moment_API35');
 await require('./emulator-system-ui-ready.cjs')(serial);
 // Clear only this emulator app's abandoned activity-result callback after a
 // failed/OS-blocked picker attempt; business files remain intact.
 shell('shell','am','force-stop',pkg);
 assert.match(shell('shell','dumpsys','package','com.personal.schedule.safqa'),/versionName=1.0/);
 await attach();assert.equal(await client.invoke('plugin:app|version'),require('../package.json').version);assert.equal((await client.invoke('sync_get_status')).configured,false);
 before=await client.invoke('load_all_data');
 await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("设置")).click()');await until(()=>client.evaluate('Boolean(document.querySelector("input[aria-label=备份口令]"))'));
 await client.evaluate('(()=>{const e=document.querySelector("input[aria-label=备份口令]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"qa-saf-boundary-passphrase");e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');await wait(200);
 for(const[folder,pattern]of[['Permission denied',/permission|EACCES|SecurityException/i],['No space',/space|ENOSPC/i]]){
  await check('real SAF '+folder+' rejects export and leaves all business data unchanged',async()=>{
   await exportClick();await pickFault(folder);await until(()=>client.evaluate('document.body.innerText.includes("备份操作失败")&&'+pattern+'.test(document.body.innerText)'));
   assert.deepEqual(await client.invoke('load_all_data'),before);
  });
 }
 await check('cancelling the provider picker returns cancellation and preserves business data',async()=>{
  await exportClick();await find(n=>n.package?.includes('documentsui'));await cancelPicker();await until(()=>client.evaluate('[...document.querySelectorAll("button")].some(x=>x.innerText.trim()==="导出备份"&&!x.disabled)'));assert.deepEqual(await client.invoke('load_all_data'),before);
 });
}
main().catch(e=>{console.error(String(e));process.exitCode=1;try{fs.writeFileSync(path.join(out,'saf-failure-ui.json'),JSON.stringify(nodes(),null,2))}catch{}}).finally(async()=>{try{await cancelPicker()}catch{}if(client)client.close();fs.writeFileSync(path.join(out,'saf-failure-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),version:require('../package.json').version,platform:'Android15 dedicated emulator; real DocumentsProvider exceptions',physicalStorageFilled:false,productionAppChanged:false,results},null,2))});
