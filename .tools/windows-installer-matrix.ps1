# Default: prepare MSI fixtures on D:, without installing or changing registry.
# -Execute is restricted to an explicitly enabled disposable GitHub runner.
param([switch]$Execute,[string]$Msi)
$ErrorActionPreference='Stop'
if($Execute -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:MOMENT_ALLOW_INSTALLER_QA -ne '1')){throw 'Installation matrix may only execute on an explicitly enabled disposable Windows CI runner'}
. (Join-Path $PSScriptRoot 'build-env.ps1')
if($Execute -and ([IO.Path]::GetFullPath($env:GITHUB_WORKSPACE) -ne $momentProjectRoot -or [IO.Path]::GetPathRoot($momentProjectRoot) -ne 'D:\')){throw 'Installer CI workspace must be this project on D:'}
$momentVersion=(Get-Content (Join-Path $momentProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
if(-not $Msi){$Msi=Join-Path $env:CARGO_TARGET_DIR "release/bundle/msi/此刻_${momentVersion}_x64_zh-CN.msi"}
$Msi=[IO.Path]::GetFullPath($Msi)
if(-not(Test-Path -LiteralPath $Msi)){throw 'Build the current MSI first'}
$momentMatrixRoot=[IO.Path]::GetFullPath((Join-Path $momentCacheRoot 'windows-installer-matrix'))
New-Item -ItemType Directory -Force -Path $momentMatrixRoot | Out-Null
$momentInstaller=New-Object -ComObject WindowsInstaller.Installer
function Invoke-MomentMsiMethod($Object,[string]$Name,[object[]]$Arguments=@()) {
    try {$Object.GetType().InvokeMember($Name,[Reflection.BindingFlags]::InvokeMethod,$null,$Object,$Arguments)}
    catch {throw "MSI method $Name failed (argument types: $(($Arguments | ForEach-Object {$_.GetType().FullName}) -join ', ')): $($_.Exception.Message)"}
}
function Get-MomentMsiProperty($Object,[string]$Name,[object[]]$Arguments=@()) {
    $Object.GetType().InvokeMember($Name,[Reflection.BindingFlags]::GetProperty,$null,$Object,$Arguments)
}
function Set-MomentMsiProperty($Object,[string]$Name,[object[]]$Arguments) {
    $Object.GetType().InvokeMember($Name,[Reflection.BindingFlags]::SetProperty,$null,$Object,$Arguments) | Out-Null
}
function Close-MomentCom($Object) {if($null -ne $Object -and [Runtime.InteropServices.Marshal]::IsComObject($Object)){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) | Out-Null}}
function Get-MomentMsiScalar($Database,[string]$Sql) {
    $momentView=Invoke-MomentMsiMethod $Database 'OpenView' @($Sql)
    try {Invoke-MomentMsiMethod $momentView 'Execute' | Out-Null;$momentRecord=Invoke-MomentMsiMethod $momentView 'Fetch';if($null -eq $momentRecord){return $null};try {Get-MomentMsiProperty $momentRecord 'StringData' @(1)}finally{Close-MomentCom $momentRecord}}
    finally {Invoke-MomentMsiMethod $momentView 'Close' | Out-Null;Close-MomentCom $momentView}
}
function Invoke-MomentMsiSql($Database,[string]$Sql,$Record=$null) {
    $momentView=Invoke-MomentMsiMethod $Database 'OpenView' @($Sql)
    try {if($null -eq $Record){Invoke-MomentMsiMethod $momentView 'Execute' | Out-Null}else{Invoke-MomentMsiMethod $momentView 'Execute' @($Record) | Out-Null}}
    finally {Invoke-MomentMsiMethod $momentView 'Close' | Out-Null;Close-MomentCom $momentView}
}
function Get-MomentMsiFact([string]$Path) {
    $momentDatabase=Invoke-MomentMsiMethod $momentInstaller 'OpenDatabase' @($Path,0)
    try {
        $momentFact=[ordered]@{path=$Path;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
        foreach($momentName in @('ProductCode','ProductVersion','UpgradeCode')){$momentFact[$momentName]=Get-MomentMsiScalar $momentDatabase ('SELECT `Value` FROM `Property` WHERE `Property` = '''+$momentName+'''')}
        [PSCustomObject]$momentFact
    } finally {Close-MomentCom $momentDatabase}
}
$momentCandidate=Get-MomentMsiFact $Msi
$momentNumbers=$momentCandidate.ProductVersion.Split('.') | ForEach-Object {[int]$_}
if($momentNumbers.Length -ne 3 -or $momentNumbers[2] -lt 1 -or $momentNumbers[2] -ge 65535){throw 'MSI fixture versions cannot be derived safely'}
$momentLowerVersion="$($momentNumbers[0]).$($momentNumbers[1]).$($momentNumbers[2]-1)"
$momentHigherVersion="$($momentNumbers[0]).$($momentNumbers[1]).$($momentNumbers[2]+1)"
# Pass plain CLR path strings to COM, not provider-wrapped Join-Path output.
$momentFailureSource=[IO.Path]::GetFullPath((Join-Path $momentMatrixRoot 'intentional-failure.rs'))
$momentFailureExe=[IO.Path]::GetFullPath((Join-Path $momentMatrixRoot 'intentional-failure.exe'))
[IO.File]::WriteAllText($momentFailureSource,'fn main() { std::process::exit(42); }',(New-Object Text.UTF8Encoding($false)))
& rustc --edition=2021 $momentFailureSource -o $momentFailureExe
if($LASTEXITCODE -ne 0){throw 'Could not build the disposable rollback fixture'}
function New-MomentMsiFixture([string]$Name,[string]$Version,[bool]$FailAfterFiles) {
    $momentFixture=[IO.Path]::GetFullPath((Join-Path $momentMatrixRoot ($Name+'.msi')))
    Copy-Item -LiteralPath $Msi -Destination $momentFixture -Force
    $momentDatabase=Invoke-MomentMsiMethod $momentInstaller 'OpenDatabase' @($momentFixture,1)
    try {
        $momentCode='{'+[Guid]::NewGuid().ToString().ToUpperInvariant()+'}'
        Invoke-MomentMsiSql $momentDatabase ('UPDATE `Property` SET `Value` = '''+$momentCode+''' WHERE `Property` = ''ProductCode''')
        Invoke-MomentMsiSql $momentDatabase ('UPDATE `Property` SET `Value` = '''+$Version+''' WHERE `Property` = ''ProductVersion''')
        # Upgrade range columns are part of its primary key: replace records
        # instead of attempting an illegal UPDATE of key columns.
        $momentUpgradeColumns=@('UpgradeCode','VersionMin','VersionMax','Language','Attributes','Remove','ActionProperty')
        $momentUpgradeRows=New-Object Collections.Generic.List[object]
        $momentUpgradeView=Invoke-MomentMsiMethod $momentDatabase 'OpenView' @('SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Language`, `Attributes`, `Remove`, `ActionProperty` FROM `Upgrade`')
        try {Invoke-MomentMsiMethod $momentUpgradeView 'Execute' | Out-Null
            while($true){$momentRow=Invoke-MomentMsiMethod $momentUpgradeView 'Fetch';if($null -eq $momentRow){break};try{$momentValues=@();for($momentField=1;$momentField -le 7;$momentField++){$momentValues+=Get-MomentMsiProperty $momentRow 'StringData' @($momentField)};$momentUpgradeRows.Add($momentValues)}finally{Close-MomentCom $momentRow}}
        } finally {Invoke-MomentMsiMethod $momentUpgradeView 'Close' | Out-Null;Close-MomentCom $momentUpgradeView}
        Invoke-MomentMsiSql $momentDatabase 'DELETE FROM `Upgrade`'
        foreach($momentValues in $momentUpgradeRows){
            for($momentRange=1;$momentRange -le 2;$momentRange++){if($momentValues[$momentRange] -eq $momentCandidate.ProductVersion){$momentValues[$momentRange]=$Version}}
            $momentRow=Invoke-MomentMsiMethod $momentInstaller 'CreateRecord' @(7)
            try {for($momentField=1;$momentField -le 7;$momentField++){if($momentField -eq 5){Set-MomentMsiProperty $momentRow 'IntegerData' @($momentField,[int]$momentValues[$momentField-1])}elseif($momentValues[$momentField-1] -ne ''){Set-MomentMsiProperty $momentRow 'StringData' @($momentField,$momentValues[$momentField-1])}};Invoke-MomentMsiSql $momentDatabase 'INSERT INTO `Upgrade` (`UpgradeCode`, `VersionMin`, `VersionMax`, `Language`, `Attributes`, `Remove`, `ActionProperty`) VALUES (?, ?, ?, ?, ?, ?, ?)' $momentRow}finally{Close-MomentCom $momentRow}
        }
        $momentSummary=Get-MomentMsiProperty $momentDatabase 'SummaryInformation' @(10)
        try {Set-MomentMsiProperty $momentSummary 'Property' @(9,('{'+[Guid]::NewGuid().ToString().ToUpperInvariant()+'}'));Invoke-MomentMsiMethod $momentSummary 'Persist' | Out-Null}finally{Close-MomentCom $momentSummary}
        if($FailAfterFiles){
            $momentRecord=Invoke-MomentMsiMethod $momentInstaller 'CreateRecord' @(2)
            try {
                Set-MomentMsiProperty $momentRecord 'StringData' @(1,'MomentQaFailureBinary')
                Invoke-MomentMsiMethod $momentRecord 'SetStream' @(2,$momentFailureExe) | Out-Null
                Invoke-MomentMsiSql $momentDatabase 'INSERT INTO `Binary` (`Name`, `Data`) VALUES (?, ?)' $momentRecord
            }finally{Close-MomentCom $momentRecord}
            # EXE from Binary + deferred + no impersonation; exit 42 must fail.
            Invoke-MomentMsiSql $momentDatabase 'INSERT INTO `CustomAction` (`Action`, `Type`, `Source`, `Target`) VALUES (''MomentQaIntentionalFailure'', 3074, ''MomentQaFailureBinary'', '''')'
            $momentInstallFiles=[int](Get-MomentMsiScalar $momentDatabase 'SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''InstallFiles''')
            $momentFinalize=[int](Get-MomentMsiScalar $momentDatabase 'SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''InstallFinalize''')
            if($momentInstallFiles -lt 1500 -or $momentInstallFiles+1 -ge $momentFinalize){throw 'Unexpected installer sequence; refuse to guess rollback position'}
            Invoke-MomentMsiSql $momentDatabase ('INSERT INTO `InstallExecuteSequence` (`Action`, `Condition`, `Sequence`) VALUES (''MomentQaIntentionalFailure'', ''NOT REMOVE'', '+($momentInstallFiles+1)+')')
        }
        Invoke-MomentMsiMethod $momentDatabase 'Commit' | Out-Null
    } finally {Close-MomentCom $momentDatabase}
    Get-MomentMsiFact $momentFixture
}
$momentLower=New-MomentMsiFixture 'lower-version-fixture' $momentLowerVersion $false
$momentFailure=New-MomentMsiFixture 'rollback-failure-fixture' $momentHigherVersion $true
if($momentLower.UpgradeCode -ne $momentCandidate.UpgradeCode -or $momentFailure.UpgradeCode -ne $momentCandidate.UpgradeCode){throw 'Fixture upgrade identity changed'}
if($momentLower.ProductVersion -ne $momentLowerVersion -or $momentFailure.ProductVersion -ne $momentHigherVersion -or $momentLower.ProductCode -eq $momentCandidate.ProductCode -or $momentFailure.ProductCode -eq $momentCandidate.ProductCode){throw 'Fixture product versions or identities are incorrect'}
$momentFailureDatabase=Invoke-MomentMsiMethod $momentInstaller 'OpenDatabase' @([string]$momentFailure.path,0)
try {
    $momentRollbackType=[int](Get-MomentMsiScalar $momentFailureDatabase 'SELECT `Type` FROM `CustomAction` WHERE `Action` = ''MomentQaIntentionalFailure''')
    $momentRollbackSequence=[int](Get-MomentMsiScalar $momentFailureDatabase 'SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''MomentQaIntentionalFailure''')
    $momentFilesSequence=[int](Get-MomentMsiScalar $momentFailureDatabase 'SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''InstallFiles''')
    $momentFinalizeSequence=[int](Get-MomentMsiScalar $momentFailureDatabase 'SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''InstallFinalize''')
    $momentBinaryView=Invoke-MomentMsiMethod $momentFailureDatabase 'OpenView' @('SELECT `Data` FROM `Binary` WHERE `Name` = ''MomentQaFailureBinary''')
    try {Invoke-MomentMsiMethod $momentBinaryView 'Execute' | Out-Null;$momentBinaryRecord=Invoke-MomentMsiMethod $momentBinaryView 'Fetch';try{$momentBinaryBytes=Get-MomentMsiProperty $momentBinaryRecord 'DataSize' @(1)}finally{Close-MomentCom $momentBinaryRecord}}
    finally {Invoke-MomentMsiMethod $momentBinaryView 'Close' | Out-Null;Close-MomentCom $momentBinaryView}
    if($momentRollbackType -ne 3074 -or $momentRollbackSequence -le $momentFilesSequence -or $momentRollbackSequence -ge $momentFinalizeSequence -or $momentBinaryBytes -ne (Get-Item -LiteralPath $momentFailureExe).Length){throw 'Persisted rollback fixture failed independent MSI table/stream inspection'}
    $momentFailure | Add-Member -NotePropertyName rollbackFixture -NotePropertyValue @{type=$momentRollbackType;sequence=$momentRollbackSequence;afterInstallFiles=$true;beforeInstallFinalize=$true;embeddedExeBytes=$momentBinaryBytes}
} finally {Close-MomentCom $momentFailureDatabase}
if((Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLowerInvariant() -ne $momentCandidate.sha256){throw 'The actual candidate MSI was modified'}
$momentPreparation=[ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');executed=$false;candidate=$momentCandidate;lower=$momentLower;intentionalFailure=$momentFailure;fixturePayload='Same candidate application payload; synthetic MSI versions test installer transactions, not historical application-data migration';results=@(@{name='Candidate MSI is unchanged';passed=$true},@{name='Lower and higher fixture versions preserve UpgradeCode';passed=$true},@{name='Higher fixture contains a deferred EXE failure after InstallFiles';passed=$true})}
$momentPreparation | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $momentMatrixRoot 'preparation.json') -Encoding utf8
if(-not $Execute){Write-Output 'Prepared MSI fixtures only. No installer was executed.';Close-MomentCom $momentInstaller;return}
$momentInstallDir=[IO.Path]::GetFullPath((Join-Path $momentMatrixRoot 'installed-app'))
if(-not $momentInstallDir.StartsWith([IO.Path]::GetFullPath($momentMatrixRoot)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Install directory escaped the CI matrix root'}
$momentChecks=New-Object Collections.Generic.List[object]
function Invoke-MomentInstaller([string]$Operation,[string]$Package,[string]$Name) {
    $momentLog=Join-Path $momentMatrixRoot ($Name+'.log')
    $momentArguments=@($Operation,('"'+$Package+'"'),'/qn','/norestart',('INSTALLDIR="'+$momentInstallDir+'"'),'/L*V',('"'+$momentLog+'"'))
    $momentProcess=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/msiexec.exe') -ArgumentList $momentArguments -WindowStyle Hidden -Wait -PassThru
    $momentProcess.ExitCode
}
function Get-MomentProductState([string]$Code){Get-MomentMsiProperty $momentInstaller 'ProductState' @($Code)}
function Test-MomentInstalled([string]$Code){(Get-MomentProductState $Code) -eq 5}
function Add-MomentInstallCheck([string]$Name,[scriptblock]$Work){& $Work;$momentChecks.Add(@{name=$Name;passed=$true});Write-Output "PASS $Name"}
try {
    foreach($momentFact in @($momentCandidate,$momentLower,$momentFailure)){if(Test-MomentInstalled $momentFact.ProductCode){throw 'CI runner already has a matrix product installed; refusing to alter it'}}
    Add-MomentInstallCheck 'fresh installation of the lower-version fixture' {
        if((Invoke-MomentInstaller '/i' $momentLower.path '01-install-lower') -ne 0 -or -not(Test-MomentInstalled $momentLower.ProductCode)){throw 'Lower-version installation failed'}
    }
    Add-MomentInstallCheck 'candidate MSI upgrades the registered lower version' {
        if((Invoke-MomentInstaller '/i' $momentCandidate.path '02-upgrade') -ne 0 -or -not(Test-MomentInstalled $momentCandidate.ProductCode) -or (Test-MomentInstalled $momentLower.ProductCode)){throw 'Candidate upgrade failed'}
    }
    $momentInstalledExe=Join-Path $momentInstallDir 'schedule-app.exe'
    if(-not(Test-Path -LiteralPath $momentInstalledExe)){throw 'Installed executable not found under the requested D: directory'}
    $momentInstalledHash=(Get-FileHash -LiteralPath $momentInstalledExe -Algorithm SHA256).Hash
    Add-MomentInstallCheck 'downgrade is refused and leaves the candidate registered' {
        $momentExit=Invoke-MomentInstaller '/i' $momentLower.path '03-downgrade-blocked'
        if($momentExit -eq 0 -or $momentExit -eq 3010 -or -not(Test-MomentInstalled $momentCandidate.ProductCode) -or (Test-MomentInstalled $momentLower.ProductCode)){throw 'Downgrade was not safely rejected'}
        if((Get-FileHash -LiteralPath $momentInstalledExe -Algorithm SHA256).Hash -ne $momentInstalledHash){throw 'Downgrade changed the installed application'}
    }
    Add-MomentInstallCheck 'deferred higher-version failure rolls back to the installed candidate' {
        $momentExit=Invoke-MomentInstaller '/i' $momentFailure.path '04-failed-upgrade-rollback'
        if($momentExit -ne 1603 -or -not(Test-MomentInstalled $momentCandidate.ProductCode) -or (Test-MomentInstalled $momentFailure.ProductCode)){throw 'Failed upgrade did not restore the prior product registration'}
        if((Get-FileHash -LiteralPath $momentInstalledExe -Algorithm SHA256).Hash -ne $momentInstalledHash){throw 'Rollback did not preserve the prior application bytes'}
        if((Get-Content -LiteralPath (Join-Path $momentMatrixRoot '04-failed-upgrade-rollback.log') -Raw) -notmatch 'MomentQaIntentionalFailure'){throw 'Expected deferred failure was not reached'}
    }
    Add-MomentInstallCheck 'uninstall removes the application and product registration' {
        if((Invoke-MomentInstaller '/x' $momentCandidate.ProductCode '05-uninstall') -ne 0 -or (Test-MomentInstalled $momentCandidate.ProductCode) -or (Test-Path -LiteralPath $momentInstalledExe)){throw 'Uninstall failed'}
    }
    Add-MomentInstallCheck 'candidate supports a clean reinstall' {
        if((Invoke-MomentInstaller '/i' $momentCandidate.path '06-reinstall') -ne 0 -or -not(Test-MomentInstalled $momentCandidate.ProductCode)){throw 'Reinstallation failed'}
        if((Get-FileHash -LiteralPath $momentInstalledExe -Algorithm SHA256).Hash -ne $momentInstalledHash){throw 'Reinstallation payload differs'}
    }
} catch {$momentChecks.Add(@{name='installer matrix';passed=$false;error=$_.Exception.Message});throw}
finally {
    foreach($momentFact in @($momentFailure,$momentCandidate,$momentLower)){if(Test-MomentInstalled $momentFact.ProductCode){Invoke-MomentInstaller '/x' $momentFact.ProductCode ('cleanup-'+$momentFact.ProductVersion) | Out-Null}}
    @{recordedAt=[DateTime]::UtcNow.ToString('o');executed=$true;os=[Environment]::OSVersion.VersionString;sourceCommit=$env:GITHUB_SHA;candidateSha256=$momentCandidate.sha256;results=@($momentChecks)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $momentMatrixRoot 'installation-results.json') -Encoding utf8
    Close-MomentCom $momentInstaller
}
