// Production-certificate install checks only on the disposable, named emulator.
// Its synthetic business files are backed up and restored to Debug afterwards.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process');const serial=process.env.MOMENT_EMULATOR||'emulator-5554';assert.ok(serial.startsWith('emulator-'));
const root=path.resolve(__dirname,'..'),pkg='com.personal.schedule',version=require('../package.json').version;
const adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),out=path.join(root,'.build-cache/android-evidence'),base=path.join(root,'.build-cache/releases',version);
const release=path.join(base,`MOMENT-${version}-arm64-release.apk`),debug=path.join(base,`MOMENT-${version}-x86_64-debug.apk`);
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];let before,backup,changed=false,restored=false;
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function files(){return shell('shell','run-as',pkg,'find','.','-type','f').split(/\s+/).map(f=>f.replace(/^\.\//,'')).filter(f=>/^(?:(?:config|events|routines|tasks|long_tasks|templates)\.json|archive\/\d{4}-\d{2}\.json)$/.test(f)).sort()}
function fingerprint(){return files().map(file=>({file,sha256:crypto.createHash('sha256').update(canonical(JSON.parse(shell('exec-out','run-as',pkg,'cat',file)))).digest('hex')}))}
function nodes(){const file='/sdcard/moment-project-release-ui.xml';assert.match(shell('shell','uiautomator','dump',file),/dumped to:/);const xml=shell('shell','cat',file);shell('shell','rm','-f',file);return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]))).filter(n=>n.package===pkg)}
function tap(node){assert.ok(node,'Observed owned UI control required');const p=node.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)))}
async function find(test){for(let n=0;n<20;n++){try{const match=nodes().find(node=>{const b=node.bounds.match(/-?\d+/g).map(Number);return b[0]>=0&&b[1]>=0&&b[2]>b[0]&&b[3]>b[1]&&test(node)});if(match)return match}catch{}await wait(300)}throw Error('Owned Release UI control not ready: '+String(test))}
async function visible(text){return find(n=>(n.text||'').includes(text))}
async function floatingPage(){tap(await visible('打开导航'));tap(await find(n=>(n.text||'').includes('浮动')&&(n.text||'').length<12))}
async function check(name,work){const start=Date.now();try{await work();results.push({name,passed:true,ms:Date.now()-start});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:String(error)});throw error}}
async function restore(){
 if(!changed||restored)return;
 shell('uninstall',pkg);assert.match(shell('install',debug),/Success/);
 shell('shell','run-as',pkg,'mkdir','-p','archive');
 execFileSync(adb,['-s',serial,'shell','-T','run-as',pkg,'tar','-xf','-'],{input:fs.readFileSync(backup),timeout:60000,maxBuffer:1024*1024});
 assert.deepEqual(fingerprint(),before,'Emulator business JSON restore failed');restored=true;
 shell('shell','input','keyevent','KEYCODE_WAKEUP');shell('shell','am','start','-n',pkg+'/.MainActivity');
}
async function main(){
 assert.equal(shell('emu','avd','name').trim().split(/\s+/)[0],'Moment_API35');assert.match(shell('shell','getprop','ro.product.cpu.abilist'),/arm64-v8a/,'This named emulator must support native ARM translation');
 fs.mkdirSync(out,{recursive:true});
 await check('preserve the named emulator business JSON before changing its signing certificate',async()=>{
  assert.equal(fs.readFileSync(path.join(base,'android-certificate.json'),'utf8').includes('aef96e480b4ec12fe56b716167a2d154139561f03579fa7c96f7fb0fca12028d'),true);
  before=fingerprint();assert.ok(before.length>1);backup=path.join(out,'pre-project-release-business.tar');
  fs.writeFileSync(backup,execFileSync(adb,['-s',serial,'exec-out','run-as',pkg,'tar','-cf','-',...files()],{timeout:30000,maxBuffer:64*1024*1024}));
 });
 await check('fresh install the project-certificate ARM Release on the disposable emulator',async()=>{
  assert.match(shell('uninstall',pkg),/Success/);changed=true;assert.match(shell('install',release),/Success/);
  const info=shell('shell','dumpsys','package',pkg);assert.ok(info.includes('versionName='+version));const flags=info.split('\n').find(l=>/^\s+flags=\[/.test(l));assert.ok(flags&&!flags.includes('DEBUGGABLE'));
  shell('shell','input','keyevent','KEYCODE_WAKEUP');shell('shell','input','keyevent','KEYCODE_MENU');assert.match(shell('shell','am','start','-W','-n',pkg+'/.MainActivity'),/Status: ok/);await visible('此刻 MOMENT');
 });
 const title='QA-production-upgrade';
 await check('create a synthetic item through the optimized Release native interface',async()=>{
  await floatingPage();tap(await visible('新建浮动事项'));
  tap(await find(n=>n.class==='android.widget.EditText'&&(n.text===''||(n.text||'').includes('输入标题'))));shell('shell','input','text',title);await visible(title);
  tap(await find(n=>n.text==='保存'));await visible(title);
 });
 await check('same project certificate replacement preserves the saved synthetic item',async()=>{
  shell('shell','am','force-stop',pkg);assert.match(shell('install','-r',release),/Success/);shell('shell','am','start','-n',pkg+'/.MainActivity');await visible('此刻 MOMENT');
  await floatingPage();await visible(title);
 });
 await check('mismatched Debug certificate is rejected without removing the Release data',async()=>{
  let rejected=false;try{shell('install','-r',debug)}catch(error){rejected=/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(error.stderr||error.stdout||error))}assert.ok(rejected);await visible(title);
 });
 await check('restore Debug and verify every backed-up emulator business JSON',restore);
}
main().catch(error=>{console.error(String(error));if(changed){try{fs.writeFileSync(path.join(out,'project-release-failure-ui.json'),JSON.stringify(nodes(),null,2))}catch{}}process.exitCode=1}).finally(async()=>{
 try{await restore()}catch(error){console.error('Emulator restore requires attention: '+String(error));process.exitCode=1}
 fs.writeFileSync(path.join(out,'project-release-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),serial,version,releaseSha256:crypto.createHash('sha256').update(fs.readFileSync(release)).digest('hex'),productionSigning:true,abi:'arm64-v8a via Android native translation on x86_64',replacementVersionCodeUnchanged:true,originalEmulatorBusinessVerified:restored,results},null,2));
});
