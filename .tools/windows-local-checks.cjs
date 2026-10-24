// Launch the explicit marked native QA window, then run local regressions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{spawn,execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.build-cache/windows-evidence'),dir=path.join(base,'data');let client,child,owned=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 assert.equal(fs.readFileSync(path.join(dir,'.moment-qa-root'),'utf8'),'moment-isolated-test-data-v1');
 try{await fetch('http://127.0.0.1:9225/json/list');throw Error('QA port 9225 is occupied')}catch(e){if(/occupied/.test(String(e)))throw e}
 child=spawn(path.join(process.env.CARGO_TARGET_DIR,'debug/schedule-app.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,MOMENT_QA_DATA_DIR:dir,APPDATA:path.join(base,'roaming'),LOCALAPPDATA:path.join(base,'local'),WEBVIEW2_USER_DATA_FOLDER:path.join(base,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9225'}});
 for(let n=0;n<50;n++){try{client=await Client.connect(9225);await client.assertWindowsIsolation();owned=true;break}catch{if(client)client.close()}await wait(200)}assert.ok(owned,'Marked Windows QA window required');client.close();client=null;
 for(const script of ['windows-smoke.cjs','windows-ui-checks.cjs','windows-performance.cjs']){
  const output=execFileSync(process.execPath,[path.join(__dirname,script)],{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(base,script.replace('.cjs','-rc1.log')),output);process.stdout.write(output);
 }
}
main().catch(e=>{console.error(String(e));process.exitCode=1}).finally(async()=>{if(owned){try{client=await Client.connect(9225);await client.assertWindowsIsolation();await client.invoke('sync_exit')}catch(e){if(!/closed/.test(String(e))){console.error(String(e));process.exitCode=1}}}if(client)client.close();if(child&&child.exitCode===null){await wait(500);if(child.exitCode===null)child.kill()}});
