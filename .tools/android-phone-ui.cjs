// Visual/IME checks only; never saves a business item or fills real credentials.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const serial=require('./authorized-phone.cjs').authorizedPhone();
const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),out=path.resolve(__dirname,'../.build-cache/honor70-evidence');
fs.mkdirSync(out,{recursive:true});
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000});const wait=ms=>new Promise(r=>setTimeout(r,ms));const results=[];let client;
async function until(test){for(let n=0;n<40;n++){if(await test())return;await wait(100)}throw Error('Phone UI condition did not become ready')}
async function check(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
function screenshot(name){fs.writeFileSync(path.join(out,name),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{timeout:30000,maxBuffer:16*1024*1024}))}
function nativeNodes(){
 const file='/sdcard/moment-phone-ui-'+Date.now()+'.xml';const dumped=shell('shell','uiautomator','dump',file);if(!dumped.includes('dumped to:'))return[];
 const source=shell('shell','cat',file);shell('shell','rm','-f',file);return [...source.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));
}
function nativeTap(node){const p=node.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)))}
async function main(){
 assert.doesNotMatch(shell('shell','dumpsys','window','policy'),/mIsShowing=true|^\s+showing=true/m,'Phone must be unlocked');
 for(let n=0;n<30;n++){try{const pid=shell('shell','pidof','com.personal.schedule').trim();assert.match(pid,/^\d+$/);shell('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);client=await Client.connect(9223);break}catch{await wait(500)}}assert.ok(client,'Owned application WebView did not become ready');
 assert.equal((await client.invoke('sync_get_status')).configured,false,'Finish cloud cleanup first');
 await client.evaluate('location.reload();true');await until(()=>client.evaluate('Boolean(document.querySelector("nav button"))'));
 await check('new-item drawer and title input fit the physical phone viewport',async()=>{
  await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("浮动")).click()');await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.includes("新建浮动事项")).click()');
  const size=await client.evaluate('(()=>{const e=document.querySelector("input[placeholder=输入标题]"),r=e.getBoundingClientRect(),d=e.closest("div.fixed").getBoundingClientRect();return{viewport:innerWidth,title:{left:r.left,right:r.right},drawer:{left:d.left,right:d.right,width:d.width},height:innerHeight}})()');
  assert.ok(size.drawer.left>=0&&size.drawer.right<=size.viewport,JSON.stringify(size));assert.ok(size.title.left>=0&&size.title.right<=size.viewport);
  fs.writeFileSync(path.join(out,'drawer-measurement.json'),JSON.stringify(size,null,2));screenshot('drawer.png');
 });
 await check('soft keyboard shrinks WebView, keeps title visible, and Back preserves the drawer',async()=>{
  const before=await client.evaluate('innerHeight');const point=await client.evaluate('(()=>{const e=document.querySelector("input[placeholder=输入标题]");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()');
  const nodes=nativeNodes(),web=nodes.find(n=>n.package==='com.personal.schedule'&&n.class==='android.webkit.WebView'&&n.bounds!=='[0,0][0,0]');assert.ok(web,'Owned native WebView bounds are required');
  const bounds=web.bounds.match(/\d+/g).map(Number),scale=(bounds[2]-bounds[0])/(await client.evaluate('innerWidth'));
  shell('shell','input','tap',String(Math.round(bounds[0]+point.x*scale)),String(Math.round(bounds[1]+point.y*scale)));
  await until(async()=>(await client.evaluate('innerHeight'))<before-60);
  const after=await client.evaluate('({height:innerHeight,bottom:document.activeElement.getBoundingClientRect().bottom,placeholder:document.activeElement.getAttribute("placeholder")})');assert.equal(after.placeholder,'输入标题');assert.ok(after.bottom<=after.height,JSON.stringify(after));
  fs.writeFileSync(path.join(out,'keyboard-measurement.json'),JSON.stringify({before,...after},null,2));screenshot('keyboard.png');
  shell('shell','input','keyevent','KEYCODE_BACK');await until(async()=>(await client.evaluate('innerHeight'))>=before-10);assert.equal(await client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))'),true);
  shell('shell','input','keyevent','KEYCODE_BACK');await until(async()=>!(await client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))')));
 });
 await check('native notification permission is granted for the test application',async()=>{
  const state=await client.invoke('notification_permission',{request:false});
  if(state!=='granted'){
   await client.evaluate('window.__qaPermission=window.__TAURI_INTERNALS__.invoke("notification_permission",{request:true});true');
   let allowed=false;for(let n=0;n<8;n++){const nodes=nativeNodes();if(nodes.some(x=>(x.text||'').includes('此刻'))&&nodes.some(x=>/通知|notification/i.test(x.text||''))){const button=nodes.find(x=>/^(允许|Allow|ALLOW|允许通知)$/.test(x.text||'')&&x.enabled==='true');if(button){nativeTap(button);allowed=true;break}}await wait(200)}
   // Android can resolve a previously granted permission without another dialog.
   assert.ok(allowed||(await client.invoke('notification_permission',{request:false}))==='granted','Neither a permission dialog nor an existing OS grant was observed');assert.equal(await client.evaluate('window.__qaPermission'),'granted');
  }
  assert.equal(await client.invoke('notification_permission',{request:false}),'granted');
 });
 await check('search rejects reversed dates and the filter controls fit the physical viewport',async()=>{
  await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("搜索")).click()');
  await until(()=>client.evaluate('Boolean(document.querySelector("input[aria-label=开始日期]"))'));
  await client.evaluate('(()=>{const set=(label,value)=>{const e=document.querySelector(`input[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};set("开始日期","2026-12-31");set("结束日期","2026-01-01");})()');await wait(50);
  await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==="搜索").click()');
  await until(()=>client.evaluate('document.querySelector("[role=alert]")?.innerText==="开始日期不能晚于结束日期"'));
  const size=await client.evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth,main:document.querySelector("main").scrollWidth})');assert.ok(size.document<=size.viewport,JSON.stringify(size));
  fs.writeFileSync(path.join(out,'search-measurement.json'),JSON.stringify(size,null,2));screenshot('search-range.png');
 });
  await check('calendar month, week and day controls fit the 360px phone viewport',async()=>{
    await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("日历")).click()');await until(()=>client.evaluate('document.querySelector("main h1")?.innerText==="日历"'));
    const measurements=[];
    for(const view of ['月','周','日']){
      await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.trim()==='+JSON.stringify(view)+').click()');await wait(100);
      const size=await client.evaluate('({viewport:innerWidth,width:document.querySelector("main").clientWidth,scroll:document.querySelector("main").scrollWidth,controls:[...document.querySelectorAll("main button")].filter(x=>["←","→","今天","月","周","日"].includes(x.innerText.trim())).map(x=>{const r=x.getBoundingClientRect();return{label:x.innerText,left:r.left,right:r.right}})})');
      assert.ok(size.scroll<=size.width+1,JSON.stringify(size));assert.ok(size.controls.every(x=>x.left>=-0.5&&x.right<=size.viewport+0.5),JSON.stringify(size));measurements.push({view,...size});
    }
    fs.writeFileSync(path.join(out,'calendar-measurements.json'),JSON.stringify(measurements,null,2));
  });
  await check('an unsaved long title stays inside the drawer and can be discarded with native Back',async()=>{
    await client.evaluate('[...document.querySelectorAll("nav button")].find(x=>x.innerText.includes("浮动")).click()');await client.evaluate('[...document.querySelectorAll("main button")].find(x=>x.innerText.includes("新建浮动事项")).click()');await until(()=>client.evaluate('Boolean(document.querySelector("input[placeholder=输入标题]"))'));
    await client.evaluate('(()=>{const e=document.querySelector("input[placeholder=输入标题]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"QA未保存长标题".repeat(64));e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()');await wait(100);
    const size=await client.evaluate('(()=>{const e=document.querySelector("input[placeholder=输入标题]"),r=e.getBoundingClientRect();return{length:e.value.length,left:r.left,right:r.right,viewport:innerWidth,document:document.documentElement.scrollWidth}})()');assert.ok(size.length>400);assert.ok(size.left>=0&&size.right<=size.viewport&&size.document<=size.viewport,JSON.stringify(size));
    shell('shell','input','keyevent','KEYCODE_BACK');await until(()=>client.evaluate('document.body.innerText.includes("放弃修改？")'));
    await client.evaluate('[...document.querySelectorAll("button")].filter(x=>x.innerText.trim()==="确认").at(-1).click()');await until(()=>client.evaluate('!document.querySelector("input[placeholder=输入标题]")'));
    fs.writeFileSync(path.join(out,'long-draft-measurement.json'),JSON.stringify(size,null,2));
  });
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(()=>{if(client)client.close();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'ui-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),serial,results},null,2))});
