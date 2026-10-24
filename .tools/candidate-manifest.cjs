// Inventory locally built candidates; signing does not imply release acceptance.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const out=path.join(root,'.build-cache','releases',version);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
fs.mkdirSync(out,{recursive:true});
const files=[...new Set(git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
const sources=files.filter(file=>fs.existsSync(path.join(root,file))&&fs.statSync(path.join(root,file)).isFile()).map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))}));
const androidProof=fs.readFileSync(path.join(out,`MOMENT-${version}-arm64-debug.apk-package.txt`),'utf8');
const versionMatch=androidProof.match(/versionCode='(\d+)' versionName='([^']+)'/);
if(!versionMatch||versionMatch[2]!==version)throw Error('APK version evidence does not match source version');
const sourceBytes=JSON.stringify(sources,null,2);fs.writeFileSync(path.join(out,'sources.json'),sourceBytes);
const signatures={
 'arm64-debug.apk':'Android Debug test certificate',
 'x86_64-debug.apk':'Android Debug test certificate',
 'arm64-release-unsigned.apk':'Unsigned; cannot install until signed',
 'arm64-release-test-signed.apk':'Release optimization, Android Debug test certificate; not production signing',
 'arm64-release.apk':'Release optimization, dedicated MOMENT application signing certificate; see androidSigning for key-backup status',
 'windows-debug.exe':'Unsigned Debug QA; explicit marked test directory supported',
 'windows-release.exe':'Unsigned Release; debug-only QA directory override is ignored',
 'windows.msi':'Unsigned Release installer; installation/rollback pending'
};
const artifacts=fs.readdirSync(out).filter(name=>/\.(apk|msi|exe)$/.test(name)).sort().map(name=>{
 const file=path.join(out,name),stat=fs.statSync(file),key=Object.keys(signatures).find(key=>name.endsWith(key));
 if(!key)throw Error('Unknown candidate file: '+name);
 return{file:name,bytes:stat.size,sha256:sha(fs.readFileSync(file)),builtAt:stat.mtime.toISOString(),signing:signatures[key]};
});
function json(relative){return JSON.parse(fs.readFileSync(path.join(root,relative),'utf8').replace(/^\uFEFF/,''))}
function fact(relative){const bytes=fs.readFileSync(path.join(root,relative));return{file:relative,sha256:sha(bytes)}}
function evidence(relative,extra={}){const value=json(relative),results=value.results||value.checks;if(!Array.isArray(results)||results.length===0)throw Error('Missing test results: '+relative);return{...fact(relative),recordedAt:value.recordedAt,version:value.version||null,passed:results.filter(r=>r.passed).length,total:results.length,...extra}}
const certificateFile=path.join(root,'.private/android-signing/certificate.json');let androidSigning=null;
if(fs.existsSync(certificateFile)){
 const value=JSON.parse(fs.readFileSync(certificateFile,'utf8').replace(/^\uFEFF/,''));
 const proof=fs.readFileSync(path.join(out,`MOMENT-${version}-arm64-release.apk-signature.txt`),'utf8');
 if(!proof.includes('certificate SHA-256 digest: '+value.certificateSha256))throw Error('Project-signed APK certificate does not match the established project identity');
 androidSigning={alias:value.alias,algorithm:value.algorithm,certificateSha256:value.certificateSha256,validUntil:value.validUntil,portableBackupVerified:value.portableBackupVerified};
 fs.writeFileSync(path.join(out,'android-certificate.json'),JSON.stringify(androidSigning,null,2));
}
const summary=json('.build-cache/verification/summary.json');
if(summary.version!==version||!summary.frontendBuildPassed||!summary.scriptSyntaxPassed)throw Error('Run current verification before packaging');
const verification={
 rust:summary.rust,
 sourceAudit:evidence('.build-cache/verification/source-audit.json'),
 buildAndSyntax:{...fact('.build-cache/verification/summary.json'),recordedAt:summary.recordedAt,passed:2,total:2},
 windows:evidence('.build-cache/windows-evidence/smoke-results.json'),
 windowsUi:evidence('.build-cache/windows-evidence/ui-results.json'),
 windowsFollowupUi:evidence('.build-cache/windows-evidence/followup-ui-results.json'),
 windowsLifecycle:evidence('.build-cache/windows-lifecycle/latest.json'),
 emulator:evidence('.build-cache/android-evidence/smoke-results.json',{api:36}),
 recovery:evidence('.build-cache/android-evidence/recovery-checks.json',{api:36}),
 androidNotifications:evidence('.build-cache/android-evidence/notification-results.json'),
 androidReleaseNotifications:evidence('.build-cache/android-release-notification-evidence/notification-results.json'),
 androidPackageStructure:evidence('.build-cache/android-package-evidence/package-results.json'),
 androidProjectRelease:evidence('.build-cache/android-evidence/project-release-results.json'),
 androidMinimumCompatibility:evidence('.build-cache/api26-evidence/compatibility-results.json'),
 androidTargetEnvironment:evidence('.build-cache/android-evidence/target-environment.json'),
 androidTargetLayout:evidence('.build-cache/android-evidence/layout-results.json'),
 androidLifecycle:evidence('.build-cache/android-evidence/lifecycle-results.json'),
 phoneUi:evidence('.build-cache/honor70-evidence/ui-results.json'),
 phoneRelease:evidence('.build-cache/honor70-evidence/release-results.json'),
 phoneProjectBaseline:evidence('.build-cache/honor70-evidence/project-certificate/baseline.json'),
 phoneProjectUpgrade:evidence('.build-cache/honor70-evidence/project-certificate/upgrade.json'),
 cloudContention:evidence('.build-cache/cloud-evidence/windows-contention.json'),
 cloudRoundtrip:evidence('.build-cache/cloud-evidence/roundtrip.json',{phoneOriginalDataVerified:json('.build-cache/cloud-evidence/roundtrip.json').phoneOriginalDataVerified}),
 cloudExpiry:evidence('.build-cache/cloud-evidence/windows-expiry.json',{historicalProtocolEvidence:true,realLeaseExpiry:json('.build-cache/cloud-evidence/windows-expiry.json').realProductionLeaseExpiry}),
 windowsInstallerPackage:evidence('.build-cache/windows-installer-evidence/package-results.json'),
 windowsInstallerPreparation:evidence('.build-cache/windows-installer-matrix/preparation.json',{installed:false}),
 signingBackup:evidence('.build-cache/signing-backup-qa/latest.json'),
 phoneLegacyFunctional:evidence('.build-cache/honor70-evidence/smoke-results.json',{historical:true}),
 cloudLegacyWindowsProbe:evidence('.build-cache/cloud-evidence/windows-probe.json',{historical:true}),
 performance:{...fact('.build-cache/windows-evidence/performance.json'),...json('.build-cache/windows-evidence/performance.json')}
};
const cleanup=json('.build-cache/cloud-evidence/expiry-cleanup.json');
verification.cloudExpiryCleanup={...fact('.build-cache/cloud-evidence/expiry-cleanup.json'),recordedAt:cleanup.recordedAt,passed:cleanup.passed?1:0,total:1};
const integrity=json('.build-cache/honor70-evidence/post-ui-integrity.json');
verification.phoneDataIntegrity={...fact('.build-cache/honor70-evidence/post-ui-integrity.json'),recordedAt:integrity.recordedAt,originalBusinessVerified:integrity.originalBusinessVerified,filesVerified:integrity.filesVerified};
let sustainedStability=null;
if(fs.existsSync(path.join(root,'.build-cache/windows-soak/latest.json'))){
 const value=json('.build-cache/windows-soak/latest.json');
 sustainedStability={...fact('.build-cache/windows-soak/latest.json'),recordedAt:value.recordedAt,phase:value.phase,version:value.version,requiredDurationMs:value.requiredDurationMs,elapsedMs:value.elapsedMs,cycles:value.cycles,binarySha256:value.binarySha256,checks:value.checks};
}
let installerExecuted=false;
const installation='.build-cache/windows-installer-matrix/installation-results.json';
if(fs.existsSync(path.join(root,installation))){const value=json(installation);installerExecuted=value.executed===true&&value.candidateSha256===artifacts.find(x=>x.file.endsWith('-windows.msi')).sha256&&value.results.every(x=>x.passed);verification.windowsInstallation=evidence(installation,{executed:value.executed,candidateSha256:value.candidateSha256})}
const ciPackage='.build-cache/github-ci/accepted-package.json';
if(fs.existsSync(path.join(root,ciPackage)))verification.windowsCiPackage=evidence(ciPackage,{sourceCommit:json(ciPackage).sourceCommit,run:json(ciPackage).run,url:json(ciPackage).url});
const blockers=[
 {id:'windows-installer-matrix',status:installerExecuted?'passed':'pending',detail:'Execute on a disposable authorized Windows runner; local fixtures are preparation evidence only.'},
 {id:'minimum-api-updated-engine',status:'pending',detail:'API26 native startup and old/missing-WebView guidance passed; full functionality with an updated engine on API26 is not yet verified.'},
 {id:'rc-three-day-trial',status:'pending',minimumElapsedMs:259200000},
 {id:'remaining-acceptance-combinations',status:'pending',detail:'See unchecked items in docs/V2.0_Lite_完整开发与验收计划.md.'}
];
if(!sustainedStability||sustainedStability.phase!=='passed'||sustainedStability.elapsedMs<sustainedStability.requiredDurationMs)blockers.push({id:'actual-two-hour-workload',status:'pending'});
const manifest={
 version,generatedAt:new Date().toISOString(),gitHead:git('rev-parse','HEAD').trim(),
 workingTree:git('status','--porcelain').trim()?'Uncommitted changes; see sources.json':'Clean at gitHead',
 sourceFiles:sources.length,sourceManifestSha256:sha(sourceBytes),formalRelease:false,
 android:{minSdk:Number(androidProof.match(/sdkVersion:'(\d+)'/)[1]),targetSdk:Number(androidProof.match(/targetSdkVersion:'(\d+)'/)[1]),versionCode:Number(versionMatch[1]),versionName:version},
 androidSigning,windowsSigning:'No Authenticode signature',
 platformScope:{windowsDesktop:'Windows10 verified; Windows11 untested and explicitly excluded from this release acceptance by the user on 2026-10-24'},
 toolchain:{node:process.version,rust:'1.97.1',jdk:'17.0.20.1',ndk:'29.0.13846066',gradle:'8.14.3'},
 recommendedInstallers:{android:`MOMENT-${version}-arm64-release.apk`,windows:`MOMENT-${version}-windows.msi`},
 cloudVerification:'Latest RC1 two-client contention and Windows-HONOR70 complete roundtrip passed. Actual production-lease expiry has earlier protocol evidence plus verified cleanup; exact evidence dates are retained.',
 phoneVerification:'Original phone app was upgraded using its test certificate and every original business JSON was verified. Separate project-certificate optimized QA app passed higher-version replacement and actual background delivery. Production-certificate emulator and optimized notification reboot evidence are recorded separately.',
 artifacts,verification,sustainedStability,releaseReadiness:blockers,
 documentation:'docs/V2.0_Lite_rc1_验收与发布说明.md'
};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),artifacts.map(x=>`${x.sha256}  ${x.file}`).join('\n')+'\n');
fs.writeFileSync(path.join(out,'安装说明.txt'),[
 `此刻 MOMENT ${version} 发布候选版`,
 '',
 `Android 8及以上、ARM64：${manifest.recommendedInstallers.android}`,
 `Windows x64：${manifest.recommendedInstallers.windows}`,
 '安装前核对 SHA256SUMS.txt。Windows 包尚无 Authenticode 签名。',
 '',
 'Android 现有测试证书版本无法由项目正式证书直接覆盖。',
 '当前手机保留 RC1 Debug 及原数据；请先导出并验证加密备份，再安排正式证书迁移。',
 '本次开发没有卸载手机原应用。不要为解决签名不一致直接清除应用数据。',
 'release-test-signed 为测试证书优化包；Debug、unsigned 和独立 QA 包不作为正式安装包。',
 '',
 `Android 项目证书 SHA-256：${androidSigning?.certificateSha256||'未验证'}`,
 `实际两小时测试：${sustainedStability?.phase||'无结果'}`,
 `尚待完成：${blockers.filter(x=>x.status==='pending').map(x=>x.id).join('、')||'无'}`,
 '当前 formalRelease:false。完整验收结果及限制见项目 docs/V2.0_Lite_rc1_验收与发布说明.md。',
 'manifest.json、sources.json 与原始证据记录可用于复核；私钥和用户数据不随安装包分发。',
 ''
].join('\r\n'),'utf8');
console.log(JSON.stringify({version,sourceFiles:sources.length,artifacts:artifacts.map(x=>({file:x.file,bytes:x.bytes,sha256:x.sha256})),formalRelease:false,pending:blockers.filter(x=>x.status==='pending').map(x=>x.id)},null,2));
