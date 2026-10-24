$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentSafRoot=Join-Path $PSScriptRoot 'saf-provider'
$momentSafCache=Join-Path $momentCacheRoot 'saf-provider'
$env:MOMENT_SAF_BUILD_DIR=Join-Path $momentSafCache 'build'
New-Item -ItemType Directory -Force -Path $momentSafCache | Out-Null
& (Join-Path $momentProjectRoot 'src-tauri/gen/android/gradlew.bat') -p $momentSafRoot --project-cache-dir (Join-Path $momentSafCache 'gradle') --offline --no-daemon assembleDebug *> (Join-Path $momentSafCache 'build.log')
if($LASTEXITCODE -ne 0){throw 'SAF provider build failed; inspect its D: log'}
Write-Output 'PASS emulator-only SAF fault provider built on D:'
