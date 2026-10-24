# All keys/passwords in this check are disposable synthetic fixtures. This
# script never loads the application's established signing key or password.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
. (Join-Path $PSScriptRoot 'android-signing-backup.ps1')
$momentQaRoot=Join-Path $momentProjectRoot ('.build-cache/signing-backup-qa/'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $momentQaRoot | Out-Null
$momentQaResults=New-Object Collections.Generic.List[object]
function Assert-MomentQa([bool]$Condition,[string]$Code){if(-not $Condition){throw $Code}}
function Check-MomentQa([string]$Name,[scriptblock]$Work){
    try{& $Work;$momentQaResults.Add([pscustomobject]@{name=$Name;passed=$true});Write-Output ('PASS '+$Name)}
    catch{$momentQaResults.Add([pscustomobject]@{name=$Name;passed=$false;code=$_.Exception.GetType().Name});throw}
}
$momentQaKeytool=Join-Path $env:JAVA_HOME 'bin/keytool.exe'
$momentQaKey=Join-Path $momentQaRoot 'source.p12'
$momentQaCertificate=Join-Path $momentQaRoot 'source.crt'
$momentQaBackup=Join-Path $momentQaRoot 'backup.p12'
$momentQaRandom=New-Object byte[] 32
$momentQaRng=[Security.Cryptography.RandomNumberGenerator]::Create()
$momentQaSaved=[Environment]::GetEnvironmentVariable('MOMENT_QA_KEY_PASSWORD','Process')
try{
    Check-MomentQa 'child host loads its own security module' {
        Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
        if($PSVersionTable.PSVersion.Major -le 5){Assert-MomentQa ((Get-Module Microsoft.PowerShell.Security).ModuleBase.StartsWith($PSHOME,[StringComparison]::OrdinalIgnoreCase)) 'WrongHostSecurityModule'}
    }
    Check-MomentQa 'UTF8 metadata preserves non-ASCII paths in Windows PowerShell' {
        $momentQaUnicode='D:\'+([char]0x8bc1)+([char]0x4e66)+'\key.p12'
        $momentQaJson=Join-Path $momentQaRoot 'utf8-metadata.json'
        [IO.File]::WriteAllText($momentQaJson,(@{path=$momentQaUnicode} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
        Assert-MomentQa ((Get-Content -LiteralPath $momentQaJson -Raw -Encoding UTF8 | ConvertFrom-Json).path -ceq $momentQaUnicode) 'UnicodeMetadataChanged'
    }
    $momentQaRng.GetBytes($momentQaRandom)
    $env:MOMENT_QA_KEY_PASSWORD=[Convert]::ToBase64String($momentQaRandom)
    $momentQaSourceSecret=ConvertTo-SecureString $env:MOMENT_QA_KEY_PASSWORD -AsPlainText -Force
    $momentQaRng.GetBytes($momentQaRandom)
    $momentQaNewSecret=ConvertTo-SecureString ([Convert]::ToBase64String($momentQaRandom)) -AsPlainText -Force
    $momentQaRng.GetBytes($momentQaRandom)
    $momentQaWrongSecret=ConvertTo-SecureString ([Convert]::ToBase64String($momentQaRandom)) -AsPlainText -Force
    Check-MomentQa 'masked fields and validation without displaying a window' {
        $momentQaForm=New-MomentBackupDialog -Destination $momentQaBackup -ExportAction {throw 'MustNotExport'}
        try{
            Assert-MomentQa ($momentQaForm.Tag.First.UseSystemPasswordChar -and $momentQaForm.Tag.Second.UseSystemPasswordChar) 'FieldsMustBeMasked'
            Assert-MomentQa (-not $momentQaForm.Visible -and $momentQaForm.Tag.First.Text.Length -eq 0 -and $momentQaForm.Tag.Second.Text.Length -eq 0) 'EmptyHiddenFixture'
            Assert-MomentQa ((Get-MomentBackupValidationError 'short' 'short') -eq 'PasswordTooShort') 'ShortValidation'
            Assert-MomentQa ((Get-MomentBackupValidationError 'Synthetic-Password-A' 'Synthetic-Password-B') -eq 'PasswordMismatch') 'MismatchValidation'
            Assert-MomentQa ($null -eq (Get-MomentBackupValidationError 'Synthetic-Password-A' 'Synthetic-Password-A')) 'ValidValidation'
        }finally{$momentQaForm.Dispose()}
    }
    Check-MomentQa 'disposable key generation through quiet native process' {
        $momentQaExit=Invoke-MomentKeytoolQuiet $momentQaKeytool @('-genkeypair','-alias','qa','-keyalg','RSA','-keysize','2048','-validity','1','-storetype','PKCS12','-keystore',$momentQaKey,'-storepass:env','MOMENT_QA_KEY_PASSWORD','-keypass:env','MOMENT_QA_KEY_PASSWORD','-dname','CN=MOMENT Disposable Backup QA')
        Assert-MomentQa ($momentQaExit -eq 0) 'FixtureKeyGeneration'
        $momentQaExit=Invoke-MomentKeytoolQuiet $momentQaKeytool @('-exportcert','-alias','qa','-keystore',$momentQaKey,'-storepass:env','MOMENT_QA_KEY_PASSWORD','-file',$momentQaCertificate)
        Assert-MomentQa ($momentQaExit -eq 0) 'FixtureCertificateExport'
    }
    $momentQaFingerprint=(Get-FileHash -LiteralPath $momentQaCertificate -Algorithm SHA256).Hash.ToLowerInvariant()
    $momentQaOriginalHash=(Get-FileHash -LiteralPath $momentQaKey -Algorithm SHA256).Hash
    Check-MomentQa 'portable backup reopens with a new password and the identical certificate' {
        Export-MomentSigningBackup -Keytool $momentQaKeytool -Keystore $momentQaKey -Alias 'qa' -SourcePassword $momentQaSourceSecret -BackupPassword $momentQaNewSecret -ExpectedCertificateSha256 $momentQaFingerprint -Destination $momentQaBackup
        Assert-MomentQa (Test-Path -LiteralPath $momentQaBackup) 'BackupMissing'
        Assert-MomentQa ((Get-FileHash -LiteralPath $momentQaKey -Algorithm SHA256).Hash -ceq $momentQaOriginalHash) 'SourceWasModified'
    }
    Check-MomentQa 'existing backup is never overwritten' {
        $momentQaOriginalBackupHash=(Get-FileHash -LiteralPath $momentQaBackup -Algorithm SHA256).Hash
        $momentQaRejected=$false
        try{Export-MomentSigningBackup -Keytool $momentQaKeytool -Keystore $momentQaKey -Alias 'qa' -SourcePassword $momentQaSourceSecret -BackupPassword $momentQaNewSecret -ExpectedCertificateSha256 $momentQaFingerprint -Destination $momentQaBackup}
        catch{if($_.Exception.Message -eq 'BackupDestinationExists'){$momentQaRejected=$true}else{throw}}
        Assert-MomentQa $momentQaRejected 'ExistingTargetAccepted'
        Assert-MomentQa ((Get-FileHash -LiteralPath $momentQaBackup -Algorithm SHA256).Hash -ceq $momentQaOriginalBackupHash) 'BackupWasModified'
    }
    Check-MomentQa 'wrong source password leaves no destination or staging files' {
        $momentQaFailedTarget=Join-Path $momentQaRoot 'must-not-exist.p12';$momentQaRejected=$false
        try{Export-MomentSigningBackup -Keytool $momentQaKeytool -Keystore $momentQaKey -Alias 'qa' -SourcePassword $momentQaWrongSecret -BackupPassword $momentQaNewSecret -ExpectedCertificateSha256 $momentQaFingerprint -Destination $momentQaFailedTarget}
        catch{if($_.Exception.Message -eq 'BackupImportFailed'){$momentQaRejected=$true}else{throw}}
        Assert-MomentQa $momentQaRejected 'WrongPasswordAccepted'
        Assert-MomentQa (-not (Test-Path -LiteralPath $momentQaFailedTarget)) 'FailedDestinationCreated'
        Assert-MomentQa (@(Get-ChildItem -LiteralPath $momentQaRoot -Filter '.backup-*' -Force).Count -eq 0) 'StagingWasRetained'
    }
    Check-MomentQa 'certificate mismatch preserves source and cleans the staged copy' {
        $momentQaFailedTarget=Join-Path $momentQaRoot 'wrong-certificate.p12';$momentQaRejected=$false
        try{Export-MomentSigningBackup -Keytool $momentQaKeytool -Keystore $momentQaKey -Alias 'qa' -SourcePassword $momentQaSourceSecret -BackupPassword $momentQaNewSecret -ExpectedCertificateSha256 ('0'*64) -Destination $momentQaFailedTarget}
        catch{if($_.Exception.Message -eq 'BackupCertificateMismatch'){$momentQaRejected=$true}else{throw}}
        Assert-MomentQa $momentQaRejected 'WrongCertificateAccepted'
        Assert-MomentQa (-not (Test-Path -LiteralPath $momentQaFailedTarget)) 'InvalidDestinationCreated'
        Assert-MomentQa ((Get-FileHash -LiteralPath $momentQaKey -Algorithm SHA256).Hash -ceq $momentQaOriginalHash) 'SourceWasModified'
        Assert-MomentQa (@(Get-ChildItem -LiteralPath $momentQaRoot -Filter '.backup-*' -Force).Count -eq 0) 'StagingWasRetained'
    }
}finally{
    [Environment]::SetEnvironmentVariable('MOMENT_QA_KEY_PASSWORD',$momentQaSaved,'Process')
    foreach($momentQaSecret in @($momentQaSourceSecret,$momentQaNewSecret,$momentQaWrongSecret)){if($momentQaSecret){$momentQaSecret.Dispose()}}
    [Array]::Clear($momentQaRandom,0,$momentQaRandom.Length);$momentQaRng.Dispose()
    $momentQaRecord=[ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');hostVersion=$PSVersionTable.PSVersion.ToString();productionKeyAccessed=$false;results=$momentQaResults.ToArray()}
    $momentQaRecord | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $momentQaRoot 'results.json') -Encoding UTF8
    if($momentQaResults.Count -eq 8 -and @($momentQaResults | Where-Object {-not $_.passed}).Count -eq 0){$momentQaRecord | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $momentQaRoot) 'latest.json') -Encoding UTF8}
    Write-Output ('Evidence: '+$momentQaRoot)
}
