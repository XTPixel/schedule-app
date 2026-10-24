# Dot-source before building/testing. All generated project data stays on D:.
# Start-Process from PowerShell 7 can pass its module search path to Windows
# PowerShell 5. Prefer the child host's own built-ins before importing security
# commands such as ConvertTo-SecureString.
if($PSVersionTable.PSVersion.Major -le 5){
    $momentBuiltinModuleRoot=[IO.Path]::Combine($PSHOME,'Modules')
    if(-not $env:PSModulePath.StartsWith($momentBuiltinModuleRoot+';',[StringComparison]::OrdinalIgnoreCase)){
        $env:PSModulePath=$momentBuiltinModuleRoot+';'+$env:PSModulePath
    }
}
$momentProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$momentCacheRoot = Join-Path $momentProjectRoot '.build-cache'
if (Test-Path -LiteralPath 'D:\moment-build\cargo-target') {
    $momentCacheRoot = 'D:\moment-build'
}
foreach ($momentSubdirectory in @('tmp','gradle','android-user','android-avd','npm')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $momentCacheRoot $momentSubdirectory) | Out-Null
}
$env:CARGO_TARGET_DIR = Join-Path $momentProjectRoot 'src-tauri\target'
if ($momentCacheRoot -eq 'D:\moment-build') { $env:CARGO_TARGET_DIR = 'D:\moment-build\cargo-target' }
$env:CARGO_HOME = Join-Path $momentCacheRoot 'cargo'
$env:RUSTUP_HOME = Join-Path $momentCacheRoot 'rustup'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_BUILD_JOBS = '4'
if (Test-Path -LiteralPath 'D:\moment-native-build\.moment-build-root') {
    $momentNativeOwner = (Get-Content -LiteralPath 'D:\moment-native-build\.moment-build-root' -Raw -Encoding UTF8).Trim()
    if ($momentNativeOwner -eq $momentProjectRoot) {
        $env:CARGO_HOME = 'D:\moment-native-build\cargo'
        $env:RUSTUP_HOME = 'D:\moment-native-build\rustup'
        $env:CARGO_TARGET_DIR = 'D:\moment-native-build\target'
    }
}
$env:GRADLE_USER_HOME = Join-Path $momentCacheRoot 'gradle'
$env:ANDROID_USER_HOME = Join-Path $momentCacheRoot 'android-user'
$env:ANDROID_AVD_HOME = Join-Path $momentCacheRoot 'android-avd'
$env:TEMP = Join-Path $momentCacheRoot 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $momentCacheRoot 'npm'
# Keep the installed compiler/platform tools read-only in their original SDK.
# The emulator and images installed for this project live in .build-cache.
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
# NDK .cmd link wrappers corrupt Unicode paths on Windows. Invoke clang.exe
# directly, with the same target triple the wrapper would have supplied.
$momentNdkRoot = Join-Path $env:ANDROID_HOME 'ndk\29.0.13846066'
$momentClangPath = Join-Path $momentNdkRoot 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe'
if (Test-Path -LiteralPath $momentClangPath) {
    $env:CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS = "-Clinker=$momentClangPath -Clink-arg=--target=x86_64-linux-android24"
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = "-Clinker=$momentClangPath -Clink-arg=--target=aarch64-linux-android24"
}
