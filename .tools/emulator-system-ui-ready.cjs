// Cold software-rendered emulators can show an OS System UI ANR. Preserve the
// alert and acknowledge only its observed Wait button; never dismiss app ANRs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process');
module.exports=async function(serial){
 assert.ok(['emulator-5554','emulator-5558'].includes(serial));
 const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe');
 const shell=(...a)=>execFileSync(adb,['-s',serial,...a],{encoding:'utf8',timeout:30000});
 assert.ok(['Moment_API35','Moment_API36'].includes(shell('emu','avd','name').trim().split(/\s+/)[0]));
 shell('shell','input','keyevent','KEYCODE_WAKEUP');
 for(let n=0;n<3;n++){
  const file='/sdcard/moment-system-ui-ready.xml';shell('shell','uiautomator','dump',file);
  const xml=shell('shell','cat',file);shell('shell','rm','-f',file);
  if(!xml.includes('System UI isn'))return;
  const nodes=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));
  const button=nodes.find(x=>x.package==='android'&&x.text==='Wait');assert.ok(button,'Observed OS Wait control required');
  const out=path.resolve(__dirname,'../.build-cache/android-evidence');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'system-ui-alert-'+Date.now()+'.xml'),xml);
  const b=button.bounds.match(/\d+/g).map(Number);assert.ok(b[2]>b[0]&&b[3]>b[1]);
  shell('shell','input','tap',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)));
  await new Promise(r=>setTimeout(r,1000));
 }
 throw Error('The emulator OS System UI is still unresponsive; no application result accepted');
};
