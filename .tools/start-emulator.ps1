param([ValidateRange(2048,4096)][int]$MemoryMB=3072)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentEmulatorSdk=Join-Path $momentCacheRoot 'android-sdk'
$momentEmulator=Join-Path $momentEmulatorSdk 'emulator/emulator.exe'
$momentSystemImage=Join-Path $momentEmulatorSdk 'system-images/android-35/google_apis/x86_64/system.img'
if(-not (Test-Path -LiteralPath $momentSystemImage)){throw 'The project Android 35 system image is missing on D:'}
if(-not (Test-Path -LiteralPath (Join-Path $env:ANDROID_AVD_HOME 'Moment_API35.avd/config.ini'))){throw 'The project AVD is missing'}
# Never start a second emulator against an AVD that may already be running.
if(Get-Process -Name emulator -ErrorAction SilentlyContinue){throw 'An emulator is already running; inspect it before starting another'}
$momentOldAndroidHome=$env:ANDROID_HOME
$momentOldSdkRoot=$env:ANDROID_SDK_ROOT
try {
    # Emulator resolves ANDROID_HOME before SDK_ROOT. Both must point to the
    # project SDK, while builds keep using the existing read-only C: tool SDK.
    $env:ANDROID_HOME=$momentEmulatorSdk
    $env:ANDROID_SDK_ROOT=$momentEmulatorSdk
    Start-Process -FilePath $momentEmulator -ArgumentList @('-avd','Moment_API35','-no-window','-no-snapshot','-no-audio','-gpu','swiftshader','-memory',"$MemoryMB",'-cores','2') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $momentCacheRoot 'emulator-runtime.log') -RedirectStandardError (Join-Path $momentCacheRoot 'emulator-runtime-error.log') -PassThru | Select-Object Id,ProcessName
} finally {
    $env:ANDROID_HOME=$momentOldAndroidHome
    $env:ANDROID_SDK_ROOT=$momentOldSdkRoot
}
