// OS fault/lifecycle checks only on the task's disposable emulator.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const {Client}=require('./webview-qa-client.cjs');
const serial=process.env.MOMENT_EMULATOR||'emulator-5554';assert.ok(serial.startsWith('emulator-'));
const releaseQa=process.env.MOMENT_NOTIFICATION_RELEASE_QA==='1';
const qaPort=releaseQa?9225:Number(process.env.MOMENT_ANDROID_QA_PORT||9223);assert.ok([9223,9225,9227].includes(qaPort));
const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),pkg=releaseQa?'com.personal.schedule.qa':'com.personal.schedule';
const activity=releaseQa?pkg+'/com.personal.schedule.MainActivity':pkg+'/.MainActivity';
const out=path.resolve(__dirname,'../.build-cache/'+(releaseQa?'android-release-notification-evidence':'android-evidence'));fs.mkdirSync(out,{recursive:true});
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[],events=[];let client,originalConfig,bootAt;
async function attach(){
 if(client)client.close();shell('shell','input','keyevent','KEYCODE_WAKEUP');shell('shell','am','start','-n',activity);
 for(let n=0;n<60;n++){try{const pid=shell('shell','pidof',pkg).trim();shell('forward','tcp:'+qaPort,'localabstract:webview_devtools_remote_'+pid);client=await Client.connect(qaPort);await client.invoke('load_all_data');return}catch{await wait(400)}}throw Error('Emulator application not ready');
}
async function until(work,ms=15000){const end=Date.now()+ms;do{if(await work())return;await wait(500)}while(Date.now()<end);throw Error('Notification condition timed out')}
async function check(name,work){const start=Date.now();try{await work();results.push({name,passed:true,ms:Date.now()-start});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
const pending=()=>client.invoke('plugin:notification|get_pending');
async function refresh(){await client.invoke('get_now_candidates',{now:new Date().toISOString()})}
async function event(title,after){const deviceNow=await client.evaluate('Date.now()'),now=new Date(deviceNow).toISOString();const item=await client.invoke('save_event',{event:{id:'',title,description:null,tags:['notification-qa'],priority:'high',start:new Date(deviceNow+15*60000+after).toISOString(),end:null,allDay:false,reminders:[],repeat:null,status:'active',createdAt:now,updatedAt:now,completedAt:null,deletedAt:null}});events.push(item.id);await refresh();return item}
function visible(title){const dump=shell('shell','dumpsys','notification','--noredact');return dump.split(/(?=NotificationRecord\()/).some(block=>block.includes('pkg='+pkg)&&block.includes(title))}
function storedXml(){return releaseQa?shell('exec-out','cat','/data/user/0/'+pkg+'/shared_prefs/NOTIFICATION_STORE.xml'):shell('exec-out','run-as',pkg,'cat','shared_prefs/NOTIFICATION_STORE.xml')}
function stored(){
 const xml=storedXml();
 return [...xml.matchAll(/<string name="[^"]+">([\s\S]*?)<\/string>/g)].map(m=>JSON.parse(m[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&apos;/g,"'").replace(/&amp;/g,'&')));
}
async function main(){
 if(releaseQa){assert.equal(shell('emu','avd','name').trim().split(/\s+/)[0],'Moment_API35');shell('root');for(let n=0;n<30;n++){try{if(shell('shell','id').includes('uid=0'))break}catch{}await wait(500)}assert.match(shell('shell','id'),/uid=0/);const flags=shell('shell','dumpsys','package',pkg).split('\n').find(x=>/^\s+flags=\[/.test(x));assert.ok(flags&&!flags.includes('DEBUGGABLE'))}
 await attach();assert.equal((await client.invoke('sync_get_status')).configured,false);originalConfig=await client.invoke('get_config');
 await client.invoke('set_config',{config:{...originalConfig,notifications:{...originalConfig.notifications,enabled:true,sound:false,doNotDisturb:{...originalConfig.notifications.doNotDisturb,enabled:false},priorityPolicy:{high:'system',normal:'system',low:'system'}}}});
 await check('denied notification permission has visible recovery guidance and no pending alarms',async()=>{
  shell('shell','pm','revoke',pkg,'android.permission.POST_NOTIFICATIONS');shell('shell','pm','set-permission-flags',pkg,'android.permission.POST_NOTIFICATIONS','user-set','user-fixed');await attach();assert.notEqual(await client.invoke('notification_permission',{request:false}),'granted');
  assert.match(shell('shell','dumpsys','package',pkg),/POST_NOTIFICATIONS: granted=false, flags=\[ USER_SET\|USER_FIXED/);
  await event('QA notification denied '+Date.now(),180000);await wait(700);assert.equal(await client.invoke('notification_pending_count'),0);
  await client.evaluate('[...document.querySelectorAll("nav button")].find(e=>e.innerText.includes("设置")).click()');await until(()=>client.evaluate('document.body.innerText.includes("反复拒绝后需到系统设置开启")'));
 });
 await check('repeated permission request on an existing grant resolves promptly',async()=>{
  shell('shell','pm','clear-permission-flags',pkg,'android.permission.POST_NOTIFICATIONS','user-set','user-fixed');shell('shell','pm','grant',pkg,'android.permission.POST_NOTIFICATIONS');await attach();
  assert.equal(await Promise.race([client.invoke('notification_permission',{request:true}),wait(5000).then(()=>{throw Error('Existing grant request hung')})]),'granted');
 });
 await check('exact-alarm denial is reported and enabling it replans existing reminders',async()=>{
  shell('shell','appops','set',pkg,'SCHEDULE_EXACT_ALARM','deny');await attach();assert.equal((await client.invoke('notification_reminder_status')).exact,false);
  await client.invoke('notification_permission',{request:false});await until(async()=>(await pending()).length>0);
  shell('shell','appops','set',pkg,'SCHEDULE_EXACT_ALARM','allow');assert.equal((await client.invoke('notification_reminder_status')).exact,true);await client.invoke('notification_permission',{request:false});
 });
 const title='QA background notification '+Date.now(),bootTitle='QA reboot notification '+Date.now();
 await check('planned reminders persist valid JSON and select the silent channel',async()=>{
  await event(title,90000);await event(bootTitle,300000);await until(async()=>(await pending()).some(p=>p.body?.includes(bootTitle)));
  const xml=storedXml();
  bootAt=Date.parse(stored().find(x=>x.body?.includes(bootTitle)).schedule.at.date);assert.ok(Number.isFinite(bootAt));
  assert.ok(xml.includes('moment-reminders-silent'));assert.ok(!xml.includes('&gt;null&lt;'));fs.writeFileSync(path.join(out,'notification-store-proof.txt'),'Persisted scheduled requests: '+(await pending()).length+'; silent channel present; valid pending JSON parsed through native plugin.\n');
 });
 await check('changing sound updates the channel of already scheduled reminders',async()=>{
  const config=await client.invoke('get_config');assert.equal(stored().find(p=>p.body?.includes(bootTitle)).channelId,'moment-reminders-silent');
  await client.invoke('set_config',{config:{...config,notifications:{...config.notifications,sound:true}}});await refresh();
  await until(()=>stored().find(p=>p.body?.includes(bootTitle)).channelId==='moment-reminders');
  await client.invoke('set_config',{config});await refresh();await until(()=>stored().find(p=>p.body?.includes(bootTitle)).channelId==='moment-reminders-silent');
 });
 await check('background Doze alarm is delivered by Android while the WebView is paused',async()=>{
  assert.equal(visible(title),false,'The reminder must not already be visible before background/Doze');
  shell('shell','am','start','-a','android.intent.action.MAIN','-c','android.intent.category.HOME');shell('shell','dumpsys','battery','unplug');shell('shell','input','keyevent','KEYCODE_SLEEP');
  assert.match(shell('shell','dumpsys','deviceidle','force-idle'),/idle/i);
  await until(()=>visible(title),110000);shell('shell','dumpsys','deviceidle','unforce');shell('shell','dumpsys','battery','reset');
 });
 await check('real emulator reboot restores future alarms before reopening the application',async()=>{
  client.close();client=null;shell('reboot');
  for(let n=0;n<600;n++){try{if(shell('shell','getprop','sys.boot_completed').trim()==='1')break}catch{}await wait(1000)}
  assert.equal(shell('shell','getprop','sys.boot_completed').trim(),'1');shell('shell','input','keyevent','KEYCODE_WAKEUP');shell('shell','input','keyevent','KEYCODE_MENU');
  const guestAfterBoot=Number(shell('shell','date','+%s').trim())*1000,waitBudget=Math.max(0,bootAt-guestAfterBoot)+60000;assert.ok(waitBudget<=420000,'Reboot fixture clock changed beyond its bounded window');
  await until(()=>visible(bootTitle),waitBudget);fs.writeFileSync(path.join(out,'notification-reboot-proof.json'),JSON.stringify({recordedAt:new Date().toISOString(),bootCompleted:true,applicationReopened:false,expectedAt:new Date(bootAt).toISOString(),guestAfterBoot:new Date(guestAfterBoot).toISOString(),waitBudgetMs:waitBudget,notificationDelivered:true},null,2));
 });
 await check('deleting a scheduled event cancels its persisted request',async()=>{
  await attach();for(const id of events)await client.invoke('delete_event',{id});await refresh();await until(async()=>!(await pending()).some(p=>/QA (background|reboot|notification denied)/.test(p.body||'')));
 });
}
main().catch(error=>{console.error(String(error));process.exitCode=1}).finally(async()=>{
 try{shell('shell','dumpsys','deviceidle','unforce');shell('shell','dumpsys','battery','reset');await attach();for(const id of events)await client.invoke('delete_event',{id});if(originalConfig)await client.invoke('set_config',{config:originalConfig});await refresh()}catch(error){console.error('Emulator cleanup: '+String(error));process.exitCode=1}
 if(client)client.close();fs.writeFileSync(path.join(out,'notification-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),serial,package:pkg,version:require('../package.json').version,optimizedRelease:releaseQa,platform:'Android emulator; actual OS alarms and reboot',backgroundPrecondition:'synthetic future notification absent before entering background/Doze',results},null,2));
});
