param([ValidateSet('x86_64','aarch64')][string]$Abi='x86_64', [switch]$Release)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentWrapper=Join-Path (Split-Path -Parent $env:CARGO_TARGET_DIR) 'rustc-android-wrapper.exe'
& rustc --edition=2021 (Join-Path $PSScriptRoot 'rustc-android-wrapper.rs') -o $momentWrapper
if ($LASTEXITCODE -ne 0) { throw '编译 Android 链接包装器失败' }
$env:RUSTC_WORKSPACE_WRAPPER=$momentWrapper
$env:MOMENT_NDK_CLANG=$momentClangPath
$momentAndroidArguments=@('run','tauri','--','android','build','--target',$Abi,'--apk','--ci')
if (-not $Release) { $momentAndroidArguments+='--debug' }
$momentProfile=if($Release){'release'}else{'debug'}
$momentBuildLog=Join-Path (Split-Path -Parent $env:CARGO_TARGET_DIR) "android-$Abi-$momentProfile-build.log"
& npm @momentAndroidArguments 2>&1 | Tee-Object -FilePath $momentBuildLog
if ($LASTEXITCODE -ne 0) {
    # Tauri requires Windows symlink privilege after compiling successfully.
    # Copy the verified native library and skip only the redundant Rust task.
    if ((Get-Content -LiteralPath $momentBuildLog -Raw) -notmatch 'Creation symbolic link is not allowed') { throw 'Android 原生构建失败，详见构建日志' }
    $momentTriple=if($Abi -eq 'x86_64'){'x86_64-linux-android'}else{'aarch64-linux-android'}
    $momentJniAbi=if($Abi -eq 'x86_64'){'x86_64'}else{'arm64-v8a'}
    $momentVariant=if($Abi -eq 'x86_64'){'X86_64'}else{'Arm64'}
    $momentProfile=if($Release){'release'}else{'debug'}
    $momentProfileLabel=if($Release){'Release'}else{'Debug'}
    $momentLibrary=Join-Path $env:CARGO_TARGET_DIR "$momentTriple\$momentProfile\libschedule_app_lib.so"
    if (-not (Test-Path -LiteralPath $momentLibrary)) { throw '已编译原生库不存在' }
    $momentAndroidProject=Join-Path $momentProjectRoot 'src-tauri\gen\android'
    $momentJniOutput=Join-Path $momentAndroidProject "app\src\main\jniLibs\$momentJniAbi"
    New-Item -ItemType Directory -Force -Path $momentJniOutput | Out-Null
    Copy-Item -LiteralPath $momentLibrary -Destination (Join-Path $momentJniOutput 'libschedule_app_lib.so') -Force
    # AGP's incremental ZIP writer can retain replaced entries, doubling debug
    # APK size. Missing final output forces a fresh APK without deleting caches.
    $momentApkAbi=if($Abi -eq 'x86_64'){'x86_64'}else{'arm64'}
    foreach($momentSuffix in @('', '-unsigned')) {
        $momentApk=Join-Path $momentAndroidProject "app/build/outputs/apk/$momentApkAbi/$momentProfile/app-$momentApkAbi-$momentProfile$momentSuffix.apk"
        if(Test-Path -LiteralPath $momentApk){Remove-Item -LiteralPath $momentApk}
    }
    Push-Location $momentAndroidProject
    try { & ./gradlew.bat --no-daemon ":app:assemble$momentVariant$momentProfileLabel" -x "rustBuild$momentVariant$momentProfileLabel" 2>&1 | Tee-Object -FilePath $momentBuildLog -Append }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Android APK 打包失败' }
}
