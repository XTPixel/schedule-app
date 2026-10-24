// Examine only files eligible for source control; never print matching secrets.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.build-cache/verification');
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).split('\0').filter(Boolean))];
const deviceFile=path.join(root,'.private/android-test-device.json');
const device=fs.existsSync(deviceFile)?JSON.parse(fs.readFileSync(deviceFile,'utf8').replace(/^\uFEFF/,'')):null;
const findings=[];
for(const file of files){
 const full=path.join(root,file);if(!fs.existsSync(full)||!fs.statSync(full).isFile())continue;
 if(/^(?:\.private|\.build-cache|node_modules|dist|src-tauri\/target)\//.test(file))findings.push({file,type:'generated-or-private-path'});
 const text=fs.readFileSync(full).toString('utf8');
 const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{36,}/,/github_pat_[A-Za-z0-9_]{50,}/,/AKIA[A-Z0-9]{16}/];
 if(patterns.some(pattern=>pattern.test(text)))findings.push({file,type:'recognizable-secret'});
 if(device?.serial&&text.includes(device.serial))findings.push({file,type:'private-device-identity'});
}
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'source-audit.json'),JSON.stringify({recordedAt:new Date().toISOString(),filesScanned:files.length,findings,results:[{name:'source inventory excludes private/generated files, recognizable private keys and tokens, and the authorized phone identity',passed:findings.length===0}]},null,2));
assert.equal(findings.length,0,'Source audit failed; inspect redacted findings in the local report');console.log('Source audit passed: '+files.length+' eligible files, no findings');
