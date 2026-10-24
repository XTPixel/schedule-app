# Repackage the existing arm64 Release library into an isolated phone QA app.
# The production Android project outputs are never overwritten by this build.
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentVersion=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
$momentQaRoot=Join-Path $momentCacheRoot 'android-phone-qa'
$momentQaProject=Join-Path $momentQaRoot ('projects/'+$momentVersion+'-'+[Guid]::NewGuid().ToString('N'))
$momentQaOutput=Join-Path $momentQaRoot ('releases/'+$momentVersion)
$momentLibrary=Join-Path $env:CARGO_TARGET_DIR 'aarch64-linux-android/release/libschedule_app_lib.so'
if(-not(Test-Path -LiteralPath $momentLibrary)){throw 'Build the arm64 Release library first'}
if([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($momentLibrary)).IndexOf($momentVersion,[StringComparison]::Ordinal) -lt 0){throw 'Release library does not contain the requested application version'}
New-Item -ItemType Directory -Force -Path $momentQaProject,$momentQaOutput | Out-Null
& robocopy.exe (Join-Path $momentProjectRoot 'src-tauri/gen/android') $momentQaProject /E /NFL /NDL /NJH /NJS /NP /XD build .gradle .tauri .idea .cxx /XF local.properties key.properties keystore.properties '*.jks' '*.keystore' *> (Join-Path $momentQaOutput 'source-copy.log')
if($LASTEXITCODE -ge 8){throw 'QA Android source copy failed'}
# Enable inspection only in this throwaway copied project. Production sources
# and Android debuggable flags remain unchanged.
$momentQaActivity=Join-Path $momentQaProject 'app/src/main/java/com/personal/schedule/MainActivity.kt'
$momentQaActivitySource=[IO.File]::ReadAllText($momentQaActivity)
$momentQaHook='super.onWebViewCreate(webView)'
if(([regex]::Matches($momentQaActivitySource,[regex]::Escape($momentQaHook))).Count -ne 1){throw 'QA WebView hook changed; inspect the copied activity'}
$momentQaActivitySource=$momentQaActivitySource.Replace($momentQaHook,$momentQaHook+"`n    WebView.setWebContentsDebuggingEnabled(true)")
[IO.File]::WriteAllText($momentQaActivity,$momentQaActivitySource,(New-Object Text.UTF8Encoding($false)))
$momentQaJni=Join-Path $momentQaProject 'app/src/main/jniLibs/arm64-v8a/libschedule_app_lib.so'
Copy-Item -LiteralPath $momentLibrary -Destination $momentQaJni -Force
Push-Location $momentQaProject
try { & ./gradlew.bat --no-daemon :app:assembleArm64Release -PmomentQaVariant=1 -x rustBuildArm64Release *> (Join-Path $momentQaOutput 'build.log') }
finally { Pop-Location }
if($LASTEXITCODE -ne 0){throw 'Isolated phone QA APK packaging failed'}
$momentQaUnsigned=Join-Path $momentQaOutput "MOMENT-$momentVersion-arm64-qa-release-unsigned.apk"
$momentQaSigned=Join-Path $momentQaOutput "MOMENT-$momentVersion-arm64-qa-release.apk"
Copy-Item -LiteralPath (Join-Path $momentQaProject 'app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk') -Destination $momentQaUnsigned -Force
$momentQaBadging=& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt.exe') dump badging $momentQaUnsigned
if($LASTEXITCODE -ne 0 -or ($momentQaBadging -join "`n") -notmatch "package: name='com.personal.schedule.qa'"){throw 'QA package identity mismatch'}
& (Join-Path $PSScriptRoot 'android-signing.ps1') -Mode Sign -UnsignedApk $momentQaUnsigned -OutputApk $momentQaSigned
$momentQaBadging | Select-String '^package:|^sdkVersion:|^targetSdkVersion:|^native-code:' | Set-Content -LiteralPath (Join-Path $momentQaOutput 'package.txt') -Encoding utf8
[PSCustomObject]@{version=$momentVersion;package='com.personal.schedule.qa';releaseSha256=(Get-FileHash -LiteralPath $momentQaSigned -Algorithm SHA256).Hash.ToLowerInvariant();nativeSha256=(Get-FileHash -LiteralPath $momentLibrary -Algorithm SHA256).Hash.ToLowerInvariant();productionCertificate=$true;optimizedRelease=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $momentQaOutput 'build-proof.json') -Encoding utf8
Write-Output "Isolated phone QA APK: $momentQaSigned"
