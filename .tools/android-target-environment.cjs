// Bind target-API acceptance to the bytes actually installed on the emulator.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');const{execFileSync}=require('node:child_process');const{Client}=require('./webview-qa-client.cjs');
const root=path.resolve(__dirname,'..'),serial='emulator-5558',pkg='com.personal.schedule',adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe'),version=require('../package.json').version;
const shell=(...a)=>execFileSync(adb,['-s',serial,...a],{encoding:'utf8',timeout:30000}),sha=b=>crypto.createHash('sha256').update(b).digest('hex');let client;
(async()=>{
 assert.equal(shell('emu','avd','name').trim().split(/\s+/)[0],'Moment_API36');const api=Number(shell('shell','getprop','ro.build.version.sdk').trim());assert.equal(api,36);
 const info=shell('shell','dumpsys','package',pkg),versionName=info.match(/versionName=(\S+)/)[1],versionCode=Number(info.match(/versionCode=(\d+)/)[1]);assert.equal(versionName,version);
 const installed=shell('shell','pm','path',pkg).trim().replace(/^package:/,'');assert.match(installed,/^\/data\/app\/[^\r\n ]+\/base\.apk$/);
 const installedSha=sha(execFileSync(adb,['-s',serial,'exec-out','cat',installed],{timeout:60000,maxBuffer:128*1024*1024}));assert.equal(installedSha,sha(fs.readFileSync(path.join(root,'.build-cache/releases',version,`MOMENT-${version}-x86_64-debug.apk`))));
 const pid=shell('shell','pidof',pkg).trim();shell('forward','tcp:9227','localabstract:webview_devtools_remote_'+pid);client=await Client.connect(9227);const nativeVersion=await client.invoke('plugin:app|version');assert.equal(nativeVersion,version);
 const provider=shell('shell','dumpsys','webviewupdate').match(/Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/);assert.ok(provider);
 const result={recordedAt:new Date().toISOString(),api,versionName,versionCode,nativeVersion,minSdk:26,targetSdk:36,abi:shell('shell','getprop','ro.product.cpu.abi').trim(),installedApkSha256:installedSha,webview:{package:provider[1],version:provider[2]},results:[{name:'Installed target-API APK bytes match the delivered candidate',passed:true},{name:'Native application version matches the source and package metadata',passed:true}]};
 fs.writeFileSync(path.join(root,'.build-cache/android-evidence/target-environment.json'),JSON.stringify(result,null,2));console.log('PASS Android16/API36 installed APK hash and native version verified');
})().catch(e=>{console.error(String(e));process.exitCode=1}).finally(()=>{if(client)client.close()});
