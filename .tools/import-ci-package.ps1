# Adopt the exact MSI/EXE from a successful, source-matched installer run.
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$momentCiRoot=Join-Path $momentCacheRoot 'github-ci'
function Read-MomentCiJson([string]$Path){Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json}
function Get-MomentCiHash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$momentSelected=Read-MomentCiJson (Join-Path $momentCiRoot 'selection.json')
if($momentSelected.run -notmatch '^\d+$' -or $momentSelected.headSha -notmatch '^[0-9a-f]{40}$'){throw 'Invalid selected CI identity'}
$momentRun=Read-MomentCiJson (Join-Path $momentCiRoot "run-$($momentSelected.run).json")
if($momentRun.status -ne 'completed' -or $momentRun.conclusion -ne 'success' -or $momentRun.headSha -ne $momentSelected.headSha){throw 'The selected source-matched CI run has not succeeded'}
Push-Location $momentProjectRoot
try {
    $momentChanged=@(& git diff --name-only $momentSelected.headSha --) + @(& git ls-files --others --exclude-standard)
    if($LASTEXITCODE -ne 0){throw 'Cannot compare candidate sources with the tested CI commit'}
    if(@($momentChanged | Where-Object {$_ -and $_ -notmatch '^(?:\.tools/|\.github/|docs/|README\.md$|\.gitignore$)'}).Count){throw 'Application inputs differ from the tested CI commit'}
} finally {Pop-Location}
$momentVersion=(Read-MomentCiJson (Join-Path $momentProjectRoot 'package.json')).version
$momentMetadata=Read-MomentCiJson (Join-Path $momentCiRoot "artifacts-$($momentSelected.run).json")
$momentArtifact=@($momentMetadata.artifacts | Where-Object {$_.name -eq 'windows-installer-evidence' -and -not $_.expired})
if($momentArtifact.Count -ne 1){throw 'Expected one unexpired Windows installer artifact'}
$momentArchive=Join-Path $momentCiRoot "windows-installer-evidence-$($momentSelected.run).zip"
$momentArchiveHash=Get-MomentCiHash $momentArchive
if($momentArtifact[0].digest -ne ('sha256:'+$momentArchiveHash)){throw 'Downloaded archive differs from GitHub artifact digest'}
$momentExtract=[IO.Path]::GetFullPath((Join-Path $momentCiRoot ("accepted/"+$momentSelected.run)))
$momentZip=[IO.Compression.ZipFile]::OpenRead($momentArchive)
try {
    $momentTotal=0L
    foreach($momentEntry in $momentZip.Entries){
        $momentTotal+=$momentEntry.Length
        $momentEntryName=$momentEntry.FullName.Replace('\','/')
        if($momentTotal -gt 1GB -or $momentEntryName.StartsWith('/') -or $momentEntryName.Contains(':') -or ($momentEntryName.Split('/') -contains '..')){throw 'Unsafe or oversized CI artifact'}
        $momentResolved=[IO.Path]::GetFullPath((Join-Path $momentExtract $momentEntryName))
        if(-not $momentResolved.StartsWith($momentExtract+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'CI archive entry escapes the extraction directory'}
    }
} finally {$momentZip.Dispose()}
if(Test-Path -LiteralPath $momentExtract){throw 'CI extraction directory already exists; inspect it before adopting again'}
[IO.Compression.ZipFile]::ExtractToDirectory($momentArchive,$momentExtract)
function Find-MomentCiFile([string]$Name){$momentFound=@(Get-ChildItem -LiteralPath $momentExtract -Recurse -File | Where-Object {$_.Name -eq $Name});if($momentFound.Count -ne 1){throw "Expected exactly one CI file: $Name"};$momentFound[0].FullName}
$momentMsi=Find-MomentCiFile "此刻_${momentVersion}_x64_zh-CN.msi"
$momentExe=Find-MomentCiFile 'schedule-app.exe'
$momentInstallFile=Find-MomentCiFile 'installation-results.json';$momentInstall=Read-MomentCiJson $momentInstallFile
$momentPreparationFile=Find-MomentCiFile 'preparation.json';$momentPreparation=Read-MomentCiJson $momentPreparationFile
$momentPackageFile=Find-MomentCiFile 'package-results.json';$momentPackage=Read-MomentCiJson $momentPackageFile
$momentSummaryFile=Find-MomentCiFile 'summary.json';$momentSummary=Read-MomentCiJson $momentSummaryFile
if(-not $momentInstall.executed -or $momentInstall.sourceCommit -ne $momentSelected.headSha -or $momentInstall.results.Count -ne 6 -or @($momentInstall.results | Where-Object {-not $_.passed}).Count){throw 'The actual six-case installation matrix did not pass for the selected source commit'}
if($momentSummary.version -ne $momentVersion -or -not $momentSummary.frontendBuildPassed -or -not $momentSummary.scriptSyntaxPassed -or $momentSummary.rust.total -ne ($momentSummary.rust.app+$momentSummary.rust.core)){throw 'CI build/test summary is invalid'}
if($momentPackage.results.Count -ne 2 -or @($momentPackage.results | Where-Object {-not $_.passed}).Count){throw 'CI package payload inspection did not pass'}
$momentMsiHash=Get-MomentCiHash $momentMsi;$momentExeHash=Get-MomentCiHash $momentExe
if($momentMsiHash -ne $momentInstall.candidateSha256 -or $momentMsiHash -ne $momentPreparation.candidate.sha256 -or $momentMsiHash -ne $momentPackage.msiSha256 -or $momentExeHash -ne $momentPackage.portableExeSha256){throw 'CI files differ from the actual tested package and executable'}
$momentRelease=Join-Path $momentCacheRoot "releases/$momentVersion"
$momentPrior=Join-Path $momentCiRoot "pre-ci-local/$momentVersion"
New-Item -ItemType Directory -Force -Path $momentPrior | Out-Null
$momentDeliverMsi=Join-Path $momentRelease "MOMENT-$momentVersion-windows.msi"
$momentDeliverExe=Join-Path $momentRelease "MOMENT-$momentVersion-windows-release.exe"
foreach($momentOld in @($momentDeliverMsi,$momentDeliverExe)){if(Test-Path -LiteralPath $momentOld){$momentOldTarget=Join-Path $momentPrior ([IO.Path]::GetFileName($momentOld));if(-not(Test-Path -LiteralPath $momentOldTarget)){Copy-Item -LiteralPath $momentOld -Destination $momentOldTarget}}}
foreach($momentProof in @(@($momentPackageFile,'windows-installer-evidence/package-results.json'),@($momentPreparationFile,'windows-installer-matrix/preparation.json'),@($momentInstallFile,'windows-installer-matrix/installation-results.json'))){
    $momentDestination=Join-Path $momentCacheRoot $momentProof[1]
    if(Test-Path -LiteralPath $momentDestination){$momentOldProof=Join-Path $momentPrior $momentProof[1];New-Item -ItemType Directory -Force -Path (Split-Path -Parent $momentOldProof) | Out-Null;Copy-Item -LiteralPath $momentDestination -Destination $momentOldProof -Force}
    Copy-Item -LiteralPath $momentProof[0] -Destination $momentDestination -Force
}
Copy-Item -LiteralPath $momentMsi -Destination $momentDeliverMsi -Force
Copy-Item -LiteralPath $momentExe -Destination $momentDeliverExe -Force
$momentProvenance=@{recordedAt=[DateTime]::UtcNow.ToString('o');version=$momentVersion;sourceCommit=$momentSelected.headSha;run=$momentSelected.run;url=$momentSelected.url;archiveSha256=$momentArchiveHash;msiSha256=$momentMsiHash;exeSha256=$momentExeHash;ciRust=$momentSummary.rust;results=@(@{name='Successful CI run matches the application source inputs';passed=$true},@{name='Archive SHA256 matches the GitHub artifact digest';passed=$true},@{name='Actual six-case installer matrix and payload inspection passed';passed=$true},@{name='Delivered MSI and EXE are the exact tested CI bytes';passed=$true})}
$momentProvenance | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $momentCiRoot 'accepted-package.json') -Encoding utf8
Write-Output "Adopted the exact tested Windows package from CI run $($momentSelected.run)."
