# Inspect every packaged shared library, not only the APK ZIP alignment.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$momentVersion=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
$momentPackages=Join-Path $momentCacheRoot "releases/$momentVersion"
$momentInspect=Join-Path $momentCacheRoot 'android-package-evidence'
$momentReadElf=Join-Path $env:ANDROID_HOME 'ndk/29.0.13846066/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe'
New-Item -ItemType Directory -Force -Path $momentInspect | Out-Null
$momentChecks=New-Object Collections.Generic.List[object]
$momentLibraries=New-Object Collections.Generic.List[object]
$momentPackageFacts=New-Object Collections.Generic.List[object]
$momentApks=@(Get-ChildItem -LiteralPath $momentPackages -File -Filter '*.apk')
$momentQaApk=Join-Path $momentCacheRoot "android-phone-qa/releases/$momentVersion/MOMENT-$momentVersion-arm64-qa-release.apk"
if(Test-Path -LiteralPath $momentQaApk){$momentApks+=Get-Item -LiteralPath $momentQaApk}
foreach($momentApk in $momentApks){
    $momentIsQa=$momentApk.Name.EndsWith('-qa-release.apk')
    $momentBadging=& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/aapt.exe') dump badging $momentApk.FullName
    if($LASTEXITCODE -ne 0){throw 'APK metadata could not be read'}
    $momentExpectedId=if($momentIsQa){'com.personal.schedule.qa'}else{'com.personal.schedule'}
    if(($momentBadging -join "`n") -notmatch ([regex]::Escape("package: name='$momentExpectedId'")) -or ($momentBadging -join "`n") -notmatch ([regex]::Escape("versionName='$momentVersion'"))){throw 'APK identity/version mismatch'}
    $momentCert=$null
    if(-not $momentApk.Name.EndsWith('-unsigned.apk')){
        $momentSignature=& (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat') verify --print-certs $momentApk.FullName 2>&1
        if($LASTEXITCODE -ne 0 -or ($momentSignature -join "`n") -notmatch 'certificate SHA-256 digest: ([0-9a-f]{64})'){throw 'APK certificate verification failed'}
        $momentCert=$Matches[1]
        $momentSignature | Set-Content -LiteralPath (Join-Path $momentInspect ($momentApk.Name+'-certificate.txt')) -Encoding utf8
    }
    $momentPackageFacts.Add(@{file=$momentApk.Name;sha256=(Get-FileHash -LiteralPath $momentApk.FullName -Algorithm SHA256).Hash.ToLowerInvariant();applicationId=$momentExpectedId;certificateSha256=$momentCert;qaOnly=$momentIsQa})
    $momentArchive=[IO.Compression.ZipFile]::OpenRead($momentApk.FullName)
    try {
        $momentEntries=@($momentArchive.Entries | Where-Object {$_.FullName -match '^lib/[^/]+/[^/]+\.so$'})
        if($momentEntries.Count -eq 0){throw "No native library in $($momentApk.Name)"}
        foreach($momentEntry in $momentEntries){
            $momentName=$momentApk.BaseName+'-'+$momentEntry.FullName.Replace('/','_')
            $momentLibrary=[IO.Path]::GetFullPath((Join-Path $momentInspect $momentName))
            $momentInput=$momentEntry.Open();$momentOutput=[IO.File]::Create($momentLibrary)
            try{$momentInput.CopyTo($momentOutput)}finally{$momentInput.Dispose();$momentOutput.Dispose()}
            $momentHeaders=& $momentReadElf --program-headers --wide $momentLibrary
            if($LASTEXITCODE -ne 0){throw "ELF inspection failed: $momentName"}
            $momentLoadLines=@($momentHeaders | Where-Object {$_ -match '^\s+LOAD\s'})
            if($momentLoadLines.Count -eq 0){throw "ELF has no loadable segments: $momentName"}
            $momentAlignments=@($momentLoadLines | ForEach-Object {if($_ -notmatch '\s(0x[0-9a-fA-F]+)\s*$'){throw 'Unrecognized ELF alignment'};[Convert]::ToInt64($Matches[1].Substring(2),16)})
            if(@($momentAlignments | Where-Object {$_ -lt 16384}).Count){throw "Native segment alignment below 16 KiB: $momentName"}
            $momentHeaders | Set-Content -LiteralPath ($momentLibrary+'-headers.txt') -Encoding utf8
            $momentLibraries.Add(@{package=$momentApk.Name;entry=$momentEntry.FullName;bytes=$momentEntry.Length;storedUncompressed=($momentEntry.Length -eq $momentEntry.CompressedLength);loadAlignments=$momentAlignments;sha256=(Get-FileHash -LiteralPath $momentLibrary -Algorithm SHA256).Hash.ToLowerInvariant()})
        }
        $momentChecks.Add(@{name=('all native LOAD segments have >=16 KiB alignment: '+$momentApk.Name);passed=$true})
    } finally {$momentArchive.Dispose()}
}
@{recordedAt=[DateTime]::UtcNow.ToString('o');version=$momentVersion;runtimeOn16KiBDeviceTested=$false;packages=@($momentPackageFacts.ToArray());libraries=@($momentLibraries.ToArray());results=@($momentChecks.ToArray())} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $momentInspect 'package-results.json') -Encoding utf8
Write-Output "PASS native ELF alignment verified for $($momentChecks.Count) APKs and $($momentLibraries.Count) libraries"
