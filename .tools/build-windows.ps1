param([switch]$BundleOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$env:LOCALAPPDATA=Join-Path $momentCacheRoot 'windows-local'
# WiX ICE loads native DLLs and fails when its temporary path resolves through
# the Unicode workspace junction. Use the physical ASCII native build root.
$momentMsiTemp=Join-Path (Split-Path -Parent $env:CARGO_TARGET_DIR) 'msi-tmp'
New-Item -ItemType Directory -Force -Path $momentMsiTemp | Out-Null
$env:TEMP=$momentMsiTemp; $env:TMP=$momentMsiTemp
$momentToolCache=Join-Path $env:CARGO_TARGET_DIR '.tauri'
$momentExistingWix=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tauri/WixTools314'
if((Test-Path -LiteralPath $momentExistingWix) -and -not (Test-Path -LiteralPath (Join-Path $momentToolCache 'WixTools314'))){
    New-Item -ItemType Directory -Force -Path $momentToolCache | Out-Null
    Copy-Item -LiteralPath $momentExistingWix -Destination $momentToolCache -Recurse
}
$momentVersion=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
if($momentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$'){throw 'Unsupported release version'}
$momentMajor=[int]$Matches[1]; $momentMinor=[int]$Matches[2]; $momentPatch=[int]$Matches[3]
$momentCandidate=99
if($Matches[4]){
    $momentNumber=[int]$Matches[5]
    if($momentNumber -lt 1 -or $momentNumber -gt 49){throw 'Candidate number must be 1..49'}
    $momentCandidate=$momentNumber
    if($Matches[4] -eq 'rc'){$momentCandidate+=49}
}
$momentMsiPatch=$momentPatch*100+$momentCandidate
if($momentMajor -gt 255 -or $momentMinor -gt 255 -or $momentMsiPatch -gt 65535){throw 'Version exceeds MSI range'}
# MSI ignores a fourth version field. Reserve candidate numbers in its third
# field so beta, rc, stable and the next patch can upgrade monotonically.
$momentMsiVersion="$momentMajor.$momentMinor.$momentMsiPatch"
$momentMsiConfig=Join-Path $momentCacheRoot 'windows-msi-config.json'
@{bundle=@{useLocalToolsDir=$true;windows=@{allowDowngrades=$false;wix=@{version=$momentMsiVersion}}}} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $momentMsiConfig -Encoding utf8
$momentLog=Join-Path $momentCacheRoot 'verification/windows-release-build.log'
Push-Location $momentProjectRoot
try{
    if(-not $BundleOnly){
        & npm run tauri -- build --no-bundle 2>&1 | Tee-Object -FilePath $momentLog
        if($LASTEXITCODE -ne 0){throw 'Windows Release build failed'}
    }
    & npm run tauri -- bundle --bundles msi --config $momentMsiConfig 2>&1 | Tee-Object -FilePath $momentLog -Append
    if($LASTEXITCODE -ne 0){throw 'Windows MSI packaging failed'}
    Write-Output "MSI version: $momentMsiVersion; app version: $momentVersion"
}finally{Pop-Location}
