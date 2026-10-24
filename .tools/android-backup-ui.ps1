# Dedicated visible password dialog, with no interactive command prompt fallback.
param([string]$BackupPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentBackupUiState=Join-Path $momentProjectRoot '.build-cache/signing-backup-status.json'
$momentBackupUiRecord=[ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');state='Starting';code=''}
$momentBackupUiRecord | ConvertTo-Json | Set-Content -LiteralPath $momentBackupUiState -Encoding UTF8
if(-not $BackupPath){$BackupPath=Join-Path $momentProjectRoot '.private/moment-release-portable-backup.p12'}
try{
    & (Join-Path $PSScriptRoot 'android-signing.ps1') -Mode ExportBackup -BackupPath $BackupPath -BackupStatusPath $momentBackupUiState | Out-Null
}catch{
    # Do not serialize the exception or native output. Startup failures leave no
    # console in which user input could accidentally be treated as a command.
    $momentBackupUiRecord['previousState']=(Get-Content -LiteralPath $momentBackupUiState -Raw -Encoding UTF8 | ConvertFrom-Json).state
    $momentBackupUiRecord['errorType']=$_.Exception.GetType().FullName
    $momentBackupUiRecord['errorId']=$_.FullyQualifiedErrorId
    $momentBackupUiRecord['scriptLine']=$_.InvocationInfo.ScriptLineNumber
    $momentBackupUiRecord['scriptStack']=$_.ScriptStackTrace
    $momentBackupUiRecord.state=if($_.Exception.Message -eq 'BackupCancelled'){'Cancelled'}else{'StartupFailed'}
    $momentBackupUiRecord.code=if($_.Exception.Message -eq 'BackupCancelled'){'UserCancelled'}else{'BackupUiStartupFailed'}
    $momentBackupUiRecord | ConvertTo-Json | Set-Content -LiteralPath $momentBackupUiState -Encoding UTF8
    exit 1
}
