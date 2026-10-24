// Read only, canonical business-file comparison against the pre-cloud backup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const serial=require('./authorized-phone.cjs').authorizedPhone();
const root=path.resolve(__dirname,'..'),adb=path.join(process.env.ANDROID_HOME,'platform-tools/adb.exe');
const baseline=JSON.parse(fs.readFileSync(path.join(root,'.build-cache/cloud-evidence/phone-pre-cloud-fingerprints.json'),'utf8'));
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
for(const entry of baseline){
 assert.match(entry.file,/^(?:(?:config|events|routines|tasks|long_tasks|templates)\.json|archive\/\d{4}-\d{2}\.json)$/);
 const raw=execFileSync(adb,['-s',serial,'exec-out','run-as','com.personal.schedule','cat',entry.file],{timeout:30000,maxBuffer:32*1024*1024});
 const sha=crypto.createHash('sha256').update(canonical(JSON.parse(raw))).digest('hex');assert.equal(sha,entry.sha256,'Original file changed: '+entry.file);
}
fs.writeFileSync(path.join(root,'.build-cache/honor70-evidence/post-ui-integrity.json'),JSON.stringify({recordedAt:new Date().toISOString(),serial,originalBusinessVerified:true,filesVerified:baseline.length},null,2));
console.log('PASS all '+baseline.length+' original phone business JSON fingerprints match the pre-cloud baseline');
