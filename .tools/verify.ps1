param([switch]$Online, [switch]$InstallDependencies)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentReports = Join-Path $momentProjectRoot '.build-cache/verification'
New-Item -ItemType Directory -Force -Path $momentReports | Out-Null
$momentReport = Join-Path $momentReports ((Get-Date).ToString('yyyyMMdd-HHmmss') + '.log')
Push-Location $momentProjectRoot
try {
    if ($InstallDependencies) {
        & npm ci 2>&1 | Tee-Object -FilePath $momentReport -Append
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }
    & npm run build 2>&1 | Tee-Object -FilePath $momentReport -Append
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    $momentRustCounts=@{}
    foreach($momentPackage in @('schedule-app','schedule-core')) {
        $momentTestArguments = @('test','--manifest-path','src-tauri/Cargo.toml','-p',$momentPackage,'--lib','--locked','--quiet')
        if (-not $Online) { $momentTestArguments += '--offline' }
        $momentRustOutput=& cargo @momentTestArguments 2>&1 | Tee-Object -FilePath $momentReport -Append
        $momentRustOutput | Write-Output
        if ($LASTEXITCODE -ne 0) { throw "Rust tests failed: $momentPackage" }
        $momentPassed=[regex]::Matches(($momentRustOutput -join "`n"),'test result: ok\. (\d+) passed; 0 failed;')
        if($momentPassed.Count -ne 1){throw "Cannot verify Rust result count: $momentPackage"}
        $momentRustCounts[$momentPackage]=[int]$momentPassed[0].Groups[1].Value
    }
    foreach ($momentScript in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cjs') {
        & node --check $momentScript.FullName
        if ($LASTEXITCODE -ne 0) { throw "Invalid test script: $($momentScript.Name)" }
    }
    foreach ($momentScript in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1') {
        $momentParseErrors=$null; $momentParseTokens=$null
        [Management.Automation.Language.Parser]::ParseFile($momentScript.FullName,[ref]$momentParseTokens,[ref]$momentParseErrors) | Out-Null
        if($momentParseErrors.Count){throw "Invalid PowerShell script: $($momentScript.Name)"}
    }
    @{
        recordedAt=[DateTime]::UtcNow.ToString('o')
        version=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
        frontendBuildPassed=$true
        scriptSyntaxPassed=$true
        rust=@{app=$momentRustCounts['schedule-app'];core=$momentRustCounts['schedule-core'];total=$momentRustCounts['schedule-app']+$momentRustCounts['schedule-core'];log=('.build-cache/verification/'+[IO.Path]::GetFileName($momentReport))}
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $momentReports 'summary.json') -Encoding utf8
    Write-Output "Verification passed. Log: $momentReport"
} finally { Pop-Location }
