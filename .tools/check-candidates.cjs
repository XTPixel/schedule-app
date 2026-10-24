// Bind delivered bytes to their source inventory and actual acceptance evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,out=path.join(root,'.build-cache/releases',version);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function local(relative){assert.ok(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.split(/[\\/]/).includes('..'),'Expected a project-relative file');return path.join(root,relative)}
function verifyFact(value){assert.match(value.sha256,/^[a-f0-9]{64}$/);assert.equal(sha(fs.readFileSync(local(value.file))),value.sha256,'Evidence changed: '+value.file)}
const manifest=read(path.join(out,'manifest.json')),sourceBytes=fs.readFileSync(path.join(out,'sources.json')),sources=JSON.parse(sourceBytes);
assert.equal(manifest.version,version);assert.equal(sha(sourceBytes),manifest.sourceManifestSha256);assert.equal(sources.length,manifest.sourceFiles);
assert.equal(new Set(sources.map(x=>x.file)).size,sources.length);
for(const entry of sources){assert.ok(!/^(?:\.private|\.build-cache|node_modules|dist)[\\/]/.test(entry.file));verifyFact(entry)}
assert.equal(manifest.artifacts.length,8,'The delivery inventory must contain exactly the eight known candidate variants');
for(const entry of manifest.artifacts){assert.equal(path.basename(entry.file),entry.file);assert.ok(!entry.file.includes('-qa-'));const bytes=fs.readFileSync(path.join(out,entry.file));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256,'Artifact changed: '+entry.file)}
const artifact=suffix=>{const items=manifest.artifacts.filter(x=>x.file.endsWith(suffix));assert.equal(items.length,1,'Ambiguous delivery artifact: '+suffix);return items[0]};
const sumLines=fs.readFileSync(path.join(out,'SHA256SUMS.txt'),'utf8').trim().split(/\r?\n/);
assert.deepEqual(sumLines,manifest.artifacts.map(x=>`${x.sha256}  ${x.file}`));
assert.equal(manifest.androidSigning.portableBackupVerified,true);
assert.deepEqual(manifest.android,{minSdk:26,targetSdk:36,versionCode:200000050,versionName:version});
assert.equal(manifest.recommendedInstallers.android,artifact('-arm64-release.apk').file);
assert.equal(manifest.recommendedInstallers.windows,artifact('-windows.msi').file);
const results=[];
for(const[name,value]of Object.entries(manifest.verification)){
 if(value.file)verifyFact(value);
 if(!Number.isInteger(value.passed)||!Number.isInteger(value.total))continue;
 assert.ok(value.total>0);assert.equal(value.passed,value.total,'Failed acceptance evidence: '+name);
 if(value.file&&name!=='buildAndSyntax'&&name!=='cloudExpiryCleanup'){
  const raw=read(local(value.file)),checks=raw.results||raw.checks;
  assert.equal(checks.length,value.total);assert.equal(checks.filter(x=>x.passed).length,value.passed);
  if(value.version)assert.equal(raw.version,value.version);
 }
 results.push({name,passed:value.passed,total:value.total});
}
const summary=read(local(manifest.verification.buildAndSyntax.file));
assert.equal(summary.version,version);assert.equal(summary.frontendBuildPassed,true);assert.equal(summary.scriptSyntaxPassed,true);
assert.deepEqual(summary.rust,manifest.verification.rust);assert.equal(summary.rust.app+summary.rust.core,summary.rust.total);
const rustLog=fs.readFileSync(local(summary.rust.log),'utf8');
for(const count of[summary.rust.app,summary.rust.core])assert.ok(rustLog.includes(`test result: ok. ${count} passed; 0 failed;`));
const packages=read(local(manifest.verification.androidPackageStructure.file));
for(const info of packages.packages){
 const delivered=manifest.artifacts.find(x=>x.file===info.file);
 if(info.qaOnly){assert.equal(info.applicationId,'com.personal.schedule.qa');assert.equal(delivered,undefined)}
 else {assert.equal(info.applicationId,'com.personal.schedule');assert.equal(info.sha256,delivered?.sha256)}
}
const production=packages.packages.find(x=>x.file===artifact('-arm64-release.apk').file);
assert.equal(production.certificateSha256,manifest.androidSigning.certificateSha256);
for(const library of packages.libraries){assert.equal(library.storedUncompressed,true);assert.ok(library.loadAlignments.length>0&&library.loadAlignments.every(x=>x>=16384))}
const nativeProduction=packages.libraries.find(x=>x.package===production.file);
const project=read(local(manifest.verification.androidProjectRelease.file));
assert.equal(project.originalEmulatorBusinessVerified,true);assert.equal(project.releaseSha256,production.sha256);
const upgrade=read(local(manifest.verification.phoneProjectUpgrade.file));
const qa=packages.packages.find(x=>x.qaOnly);
assert.equal(qa.sha256,upgrade.releaseSha256);assert.equal(qa.certificateSha256,production.certificateSha256);
assert.equal(upgrade.nativeSha256,nativeProduction.sha256);
assert.equal(packages.libraries.find(x=>x.package===qa.file).sha256,nativeProduction.sha256);
assert.equal(upgrade.productionCertificate,true);assert.equal(upgrade.optimizedRelease,true);assert.equal(upgrade.installed.debuggable,false);
assert.equal(upgrade.installed.versionName,version);assert.ok(upgrade.installed.versionCode>upgrade.from.versionCode);assert.equal(upgrade.background.delivered,true);
const target=read(local(manifest.verification.androidTargetEnvironment.file));
assert.equal(target.api,36);assert.equal(target.nativeVersion,version);assert.equal(target.installedApkSha256,artifact('-x86_64-debug.apk').sha256);
const phone=read(local(manifest.verification.phoneDataIntegrity.file));assert.equal(phone.originalBusinessVerified,true);assert.equal(phone.filesVerified,7);
assert.equal(manifest.verification.cloudRoundtrip.phoneOriginalDataVerified,true);
assert.equal(manifest.verification.cloudExpiry.realLeaseExpiry,true);assert.equal(manifest.verification.cloudExpiryCleanup.passed,1);
const installer=read(local(manifest.verification.windowsInstallerPackage.file));
assert.equal(installer.msiSha256,artifact('-windows.msi').sha256);assert.equal(installer.portableExeSha256,artifact('-windows-release.exe').sha256);
const preparation=read(local(manifest.verification.windowsInstallerPreparation.file));assert.equal(preparation.executed,false);assert.equal(preparation.candidate.sha256,installer.msiSha256);
if(manifest.verification.windowsInstallation){const actual=read(local(manifest.verification.windowsInstallation.file));assert.equal(actual.executed,true);assert.equal(actual.candidateSha256,installer.msiSha256);assert.equal(actual.results.length,6)}
if(manifest.verification.windowsCiPackage){const ci=read(local(manifest.verification.windowsCiPackage.file));assert.equal(ci.msiSha256,installer.msiSha256);assert.equal(ci.exeSha256,installer.portableExeSha256);assert.equal(ci.sourceCommit,read(local(manifest.verification.windowsInstallation.file)).sourceCommit)}
const performance=manifest.verification.performance;assert.ok(performance.items>=10000&&performance.archiveMonths>=24&&performance.writeSamples>=20);assert.ok(performance.writeP95Ms<=300);
const soak=manifest.sustainedStability;
if(soak){verifyFact(soak);assert.equal(soak.version,version);assert.equal(soak.binarySha256,artifact('-windows-debug.exe').sha256)}
if(process.argv.includes('--require-soak')){
 assert.equal(soak?.phase,'passed','The actual two-hour workload must finish before final candidate verification');
 assert.ok(soak.requiredDurationMs>=7200000&&soak.elapsedMs>=soak.requiredDurationMs);
 assert.ok(soak.checks.length>=3&&soak.checks.every(x=>x.passed));
 const raw=read(local(soak.file));assert.ok(Date.parse(raw.recordedAt)-Date.parse(raw.startedAt)>=7200000);
}
const pending=manifest.releaseReadiness.filter(x=>x.status!=='passed').map(x=>x.id);
if(manifest.formalRelease)assert.equal(pending.length,0,'Formal release has unresolved acceptance gates');
const result={recordedAt:new Date().toISOString(),version,artifactsVerified:manifest.artifacts.length,sourcesVerified:sources.length,evidenceFilesVerified:Object.values(manifest.verification).filter(x=>x.file).length,portableBackupVerified:true,originalPhoneBusinessVerified:true,projectReleasePackageVerified:true,sustainedStability:soak?.phase||'missing',formalRelease:manifest.formalRelease,pending,checks:results};
fs.writeFileSync(path.join(root,'.build-cache/verification/final-integrity.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
