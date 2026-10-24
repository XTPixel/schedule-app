# Reuse exact optimized bytes from a failed runtime test to debug CI quickly.
param([Parameter(Mandatory=$true)][long]$Run)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:MOMENT_ALLOW_INSTALLER_QA -ne '1' -or $env:GITHUB_REPOSITORY -ne 'XTPixel/schedule-app'){throw 'This probe runs only in the authorized disposable GitHub runner'}
if($Run -le 0){throw 'A positive source run ID is required'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$momentApi='https://api.github.com/repos/XTPixel/schedule-app'
$momentHeaders=@{Authorization=('Bearer '+$env:MOMENT_CI_TOKEN);Accept='application/vnd.github+json';'User-Agent'='moment-runtime-probe'}
$momentRun=Invoke-RestMethod -Uri "$momentApi/actions/runs/$Run" -Headers $momentHeaders
if($momentRun.head_branch -ne 'codex/release-2-0-rc1'){throw 'Probe source branch mismatch'}
$momentChanged=@(& git -c core.quotepath=false diff --name-only $momentRun.head_sha --)
if($LASTEXITCODE -ne 0 -or @($momentChanged | Where-Object {$_ -and $_ -notmatch '^(?:\.tools/|\.github/|docs/|README\.md$|\.gitignore$)'}).Count){throw 'Probe binary application inputs differ from this checkout'}
$momentArtifacts=(Invoke-RestMethod -Uri "$momentApi/actions/runs/$Run/artifacts" -Headers $momentHeaders).artifacts
$momentArtifact=@($momentArtifacts | Where-Object {$_.name -eq 'windows-installer-evidence' -and -not $_.expired})
if($momentArtifact.Count -ne 1){throw 'Expected one unexpired runtime artifact'}
$momentProbeDir=Join-Path $momentCacheRoot 'runtime-probe'
New-Item -ItemType Directory -Force -Path $momentProbeDir | Out-Null
$momentZipPath=Join-Path $momentProbeDir 'source.zip'
Invoke-WebRequest -Uri $momentArtifact[0].archive_download_url -Headers $momentHeaders -OutFile $momentZipPath
$momentDigest=(Get-FileHash -LiteralPath $momentZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($momentArtifact[0].digest -ne ('sha256:'+$momentDigest)){throw 'Probe artifact digest mismatch'}
$momentZip=[IO.Compression.ZipFile]::OpenRead($momentZipPath)
try {
    $momentExecutables=@($momentZip.Entries | Where-Object {$_.FullName.EndsWith('/release/schedule-app.exe')})
    if($momentExecutables.Count -ne 1 -or $momentExecutables[0].Length -gt 100MB){throw 'Invalid probe executable entry'}
    $momentOutput=Join-Path $env:CARGO_TARGET_DIR 'release/schedule-app.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $momentOutput) | Out-Null
    $momentSource=$momentExecutables[0].Open();$momentDestination=[IO.File]::Create($momentOutput)
    try{$momentSource.CopyTo($momentDestination)}finally{$momentSource.Dispose();$momentDestination.Dispose()}
} finally {$momentZip.Dispose()}
@{sourceRun=$Run;sourceCommit=$momentRun.head_sha;artifactDigest=$momentArtifact[0].digest;exeSha256=(Get-FileHash -LiteralPath $momentOutput -Algorithm SHA256).Hash.ToLowerInvariant();diagnosticOnly=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $momentProbeDir 'provenance.json') -Encoding utf8
. (Join-Path $PSScriptRoot 'windows-release-runtime.ps1')
