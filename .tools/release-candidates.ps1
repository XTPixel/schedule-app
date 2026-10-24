$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentVersion=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
$momentRelease=Join-Path $momentProjectRoot ".build-cache/releases/$momentVersion"
New-Item -ItemType Directory -Force -Path $momentRelease | Out-Null
$momentApk=Join-Path $momentProjectRoot 'src-tauri/gen/android/app/build/outputs/apk'
$momentCopies=@{
    (Join-Path $momentApk 'arm64/debug/app-arm64-debug.apk')="MOMENT-$momentVersion-arm64-debug.apk"
    (Join-Path $momentApk 'x86_64/debug/app-x86_64-debug.apk')="MOMENT-$momentVersion-x86_64-debug.apk"
    (Join-Path $momentApk 'arm64/release/app-arm64-release-unsigned.apk')="MOMENT-$momentVersion-arm64-release-unsigned.apk"
    (Join-Path $env:CARGO_TARGET_DIR 'debug/schedule-app.exe')="MOMENT-$momentVersion-windows-debug.exe"
    (Join-Path $env:CARGO_TARGET_DIR 'release/schedule-app.exe')="MOMENT-$momentVersion-windows-release.exe"
    (Join-Path $env:CARGO_TARGET_DIR "release/bundle/msi/此刻_${momentVersion}_x64_zh-CN.msi")="MOMENT-$momentVersion-windows.msi"
}
foreach($momentSource in $momentCopies.Keys){
    if(-not (Test-Path -LiteralPath $momentSource)){throw "Missing candidate: $momentSource"}
    Copy-Item -LiteralPath $momentSource -Destination (Join-Path $momentRelease $momentCopies[$momentSource]) -Force
}
$momentBuildTools=Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
$momentTestRelease=Join-Path $momentRelease "MOMENT-$momentVersion-arm64-release-test-signed.apk"
# This is the task's existing disposable Debug certificate, never a production key.
& (Join-Path $momentBuildTools 'apksigner.bat') sign --ks (Join-Path $env:ANDROID_USER_HOME 'debug.keystore') --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --v4-signing-enabled false --out $momentTestRelease (Join-Path $momentRelease "MOMENT-$momentVersion-arm64-release-unsigned.apk")
if($LASTEXITCODE -ne 0){throw 'Test-only Release signing failed'}
$momentPackages=@("MOMENT-$momentVersion-arm64-debug.apk","MOMENT-$momentVersion-x86_64-debug.apk","MOMENT-$momentVersion-arm64-release-test-signed.apk")
$momentProjectSigned=Join-Path $momentRelease "MOMENT-$momentVersion-arm64-release.apk"
if(Test-Path -LiteralPath (Join-Path $momentProjectRoot '.private/android-signing/moment-release.p12')){
    & (Join-Path $PSScriptRoot 'android-signing.ps1') -Mode Sign -UnsignedApk (Join-Path $momentRelease "MOMENT-$momentVersion-arm64-release-unsigned.apk") -OutputApk $momentProjectSigned
    $momentPackages+="MOMENT-$momentVersion-arm64-release.apk"
}elseif(Test-Path -LiteralPath $momentProjectSigned){throw 'A stale project-signed candidate exists but its signing key is unavailable'}
foreach($momentPackage in $momentPackages){
    # aapt's Windows narrow-character archive path cannot open Unicode names.
    $momentApkForTools=Join-Path $momentCacheRoot "releases/$momentVersion/$momentPackage"
    & (Join-Path $momentBuildTools 'apksigner.bat') verify --verbose --print-certs (Join-Path $momentRelease $momentPackage) 2>&1 | Tee-Object -FilePath (Join-Path $momentRelease "$momentPackage-signature.txt")
    if($LASTEXITCODE -ne 0){throw "APK signature failed: $momentPackage"}
    & (Join-Path $momentBuildTools 'zipalign.exe') -c -P 16 4 (Join-Path $momentRelease $momentPackage)
    if($LASTEXITCODE -ne 0){throw "APK page alignment failed: $momentPackage"}
    $momentBadging=& (Join-Path $momentBuildTools 'aapt.exe') dump badging $momentApkForTools
    if($LASTEXITCODE -ne 0){throw "APK metadata failed: $momentPackage"}
    if(($momentBadging -join "`n") -notmatch "package: name='com.personal.schedule' "){throw "Production APK identity mismatch: $momentPackage"}
    $momentBadging | Select-String '^package:|^sdkVersion:|^targetSdkVersion:|^native-code:' | Tee-Object -FilePath (Join-Path $momentRelease "$momentPackage-package.txt")
}
foreach($momentBinary in @("MOMENT-$momentVersion-windows-debug.exe","MOMENT-$momentVersion-windows-release.exe","MOMENT-$momentVersion-windows.msi")) {
    Get-AuthenticodeSignature -LiteralPath (Join-Path $momentRelease $momentBinary) | Select-Object Path,Status | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $momentRelease "$momentBinary-signature.json")
}
& node (Join-Path $PSScriptRoot 'candidate-manifest.cjs')
if($LASTEXITCODE -ne 0){throw 'Candidate manifest failed'}
