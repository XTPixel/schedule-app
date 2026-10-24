// Read-only extraction: no MSI installation, registry mutation or app launch.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');const root=path.resolve(__dirname,'..'),target=process.env.CARGO_TARGET_DIR;
assert.ok(target&&path.isAbsolute(target));const out=path.join(root,'.build-cache/windows-installer-evidence'),version=require('../package.json').version;
fs.mkdirSync(out,{recursive:true});
const msi=path.join(target,'release/bundle/msi',`此刻_${version}_x64_zh-CN.msi`);
try{const log=execFileSync(path.join(target,'.tauri/WixTools314/dark.exe'),['-nologo','-x',path.join(out,'extracted'),msi,'-o',path.join(out,'package.wxs')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});fs.writeFileSync(path.join(out,'extraction.log'),log)}catch(error){fs.writeFileSync(path.join(out,'extraction.log'),String(error.stdout||'')+String(error.stderr||''));throw error}
const packed=fs.readFileSync(path.join(out,'extracted/File/Path')),portable=fs.readFileSync(path.join(target,'release/schedule-app.exe'));
const marker=Buffer.from('BUNDLE_TYPE_VAR_'),offset=packed.indexOf(marker);assert.ok(offset>=0);
assert.equal(packed.indexOf(marker,offset+1),-1);assert.equal(portable.indexOf(marker),offset);assert.equal(portable.indexOf(marker,offset+1),-1);
const tag=offset+marker.length;assert.equal(packed.subarray(tag,tag+3).toString(),'MSI');assert.equal(portable.subarray(tag,tag+3).toString(),'UNK');
const a=Buffer.from(packed),b=Buffer.from(portable);a.fill(0,tag,tag+3);b.fill(0,tag,tag+3);assert.ok(a.equals(b),'MSI application differs beyond the expected Tauri bundle-type marker');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(out,'package-results.json'),JSON.stringify({recordedAt:new Date().toISOString(),installed:false,msiSha256:sha(fs.readFileSync(msi)),packedExeSha256:sha(packed),portableExeSha256:sha(portable),results:[{name:'MSI payload identifies itself as MSI and standalone EXE as UNK',passed:true},{name:'Application bytes match except the three-byte Tauri bundle-type marker',passed:true}]},null,2));
console.log('PASS MSI payload verified without installing; only its expected Tauri bundle-type marker differs');
