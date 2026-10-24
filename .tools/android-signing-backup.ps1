# Shared by the interactive exporter and disposable-key integration checks.
# Never records password text, keytool output or raw exception messages.
function Invoke-MomentKeytoolQuiet([string]$Executable,[string[]]$Arguments){
    $momentInfo=New-Object Diagnostics.ProcessStartInfo
    $momentInfo.FileName=$Executable
    $momentInfo.UseShellExecute=$false;$momentInfo.CreateNoWindow=$true
    $momentInfo.RedirectStandardOutput=$true;$momentInfo.RedirectStandardError=$true
    $momentQuoted=foreach($momentArgument in $Arguments){
        if($momentArgument.Contains('"')){throw 'NativeArgumentInvalid'}
        '"'+($momentArgument -replace '(\\+)$','$1$1')+'"'
    }
    $momentInfo.Arguments=$momentQuoted -join ' '
    $momentProcess=New-Object Diagnostics.Process
    $momentProcess.StartInfo=$momentInfo
    try{
        [void]$momentProcess.Start()
        $momentStdout=$momentProcess.StandardOutput.ReadToEndAsync()
        $momentStderr=$momentProcess.StandardError.ReadToEndAsync()
        if(-not $momentProcess.WaitForExit(60000)){$momentProcess.Kill();throw 'NativeToolTimeout'}
        [void]$momentStdout.GetAwaiter().GetResult();[void]$momentStderr.GetAwaiter().GetResult()
        return $momentProcess.ExitCode
    }finally{$momentProcess.Dispose()}
}

function Get-MomentBackupValidationError([string]$Password,[string]$Confirmation){
    if([string]::IsNullOrWhiteSpace($Password) -or $Password.Length -lt 12){return 'PasswordTooShort'}
    if($Password -match '[^\x20-\x7e]'){return 'PasswordMustBeAscii'}
    if($Password -cne $Confirmation){return 'PasswordMismatch'}
    return $null
}

function Export-MomentSigningBackup {
    param(
        [string]$Keytool,[string]$Keystore,[string]$Alias,
        [Security.SecureString]$SourcePassword,[Security.SecureString]$BackupPassword,
        [string]$ExpectedCertificateSha256,[string]$Destination
    )
    $momentFullSource=[IO.Path]::GetFullPath($Keystore)
    $momentFullDestination=[IO.Path]::GetFullPath($Destination)
    if(-not $momentFullDestination.StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($momentFullDestination) -ne '.p12'){throw 'BackupDestinationInvalid'}
    if((Test-Path -LiteralPath $momentFullDestination) -or $momentFullDestination -eq $momentFullSource){throw 'BackupDestinationExists'}
    if(-not (Test-Path -LiteralPath (Split-Path -Parent $momentFullDestination))){throw 'BackupDirectoryMissing'}
    $momentSourceHash=(Get-FileHash -LiteralPath $momentFullSource -Algorithm SHA256).Hash
    $momentStage=Join-Path (Split-Path -Parent $momentFullSource) ('.backup-'+[Guid]::NewGuid().ToString('N')+'.p12')
    $momentPublicStage=$momentStage+'.crt'
    $momentSavedSourcePassword=[Environment]::GetEnvironmentVariable('MOMENT_BACKUP_SOURCE_PASSWORD','Process')
    $momentSavedNewPassword=[Environment]::GetEnvironmentVariable('MOMENT_BACKUP_NEW_PASSWORD','Process')
    try{
        foreach($momentPair in @(@('MOMENT_BACKUP_SOURCE_PASSWORD',$SourcePassword),@('MOMENT_BACKUP_NEW_PASSWORD',$BackupPassword))){
            $momentPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($momentPair[1])
            try{[Environment]::SetEnvironmentVariable($momentPair[0],[Runtime.InteropServices.Marshal]::PtrToStringBSTR($momentPointer),'Process')}
            finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($momentPointer)}
        }
        # Only disposable staging names are written until the copied key's
        # password and public certificate are both verified.
        $momentNativeCode=Invoke-MomentKeytoolQuiet $Keytool @('-importkeystore','-srckeystore',$momentFullSource,'-srcstoretype','PKCS12','-srcalias',$Alias,'-srcstorepass:env','MOMENT_BACKUP_SOURCE_PASSWORD','-srckeypass:env','MOMENT_BACKUP_SOURCE_PASSWORD','-destkeystore',$momentStage,'-deststoretype','PKCS12','-destalias',$Alias,'-deststorepass:env','MOMENT_BACKUP_NEW_PASSWORD','-destkeypass:env','MOMENT_BACKUP_NEW_PASSWORD','-noprompt')
        if($momentNativeCode -ne 0){throw 'BackupImportFailed'}
        $momentNativeCode=Invoke-MomentKeytoolQuiet $Keytool @('-exportcert','-keystore',$momentStage,'-storetype','PKCS12','-alias',$Alias,'-storepass:env','MOMENT_BACKUP_NEW_PASSWORD','-file',$momentPublicStage)
        if($momentNativeCode -ne 0){throw 'BackupPasswordVerificationFailed'}
        $momentBackupCertificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2($momentPublicStage)
        $momentHasher=[Security.Cryptography.SHA256]::Create()
        try{$momentFingerprint=([BitConverter]::ToString($momentHasher.ComputeHash($momentBackupCertificate.RawData))).Replace('-','').ToLowerInvariant()}
        finally{$momentHasher.Dispose();$momentBackupCertificate.Dispose()}
        if($momentFingerprint -cne $ExpectedCertificateSha256){throw 'BackupCertificateMismatch'}
        if((Get-FileHash -LiteralPath $momentFullSource -Algorithm SHA256).Hash -cne $momentSourceHash){throw 'SourceSigningKeyChanged'}
        # File.Move refuses to overwrite an existing target, including a target
        # created by another process after the initial existence check.
        [IO.File]::Move($momentStage,$momentFullDestination)
    }finally{
        [Environment]::SetEnvironmentVariable('MOMENT_BACKUP_SOURCE_PASSWORD',$momentSavedSourcePassword,'Process')
        [Environment]::SetEnvironmentVariable('MOMENT_BACKUP_NEW_PASSWORD',$momentSavedNewPassword,'Process')
        foreach($momentTemporary in @($momentStage,$momentPublicStage)){
            # Exact generated files only; no recursive removal or computed trees.
            if(Test-Path -LiteralPath $momentTemporary){Remove-Item -LiteralPath $momentTemporary -Force}
        }
    }
}

function Write-MomentBackupUiStatus([string]$Path,[string]$State,[string]$Code=''){
    if($Path){[ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');state=$State;code=$Code} | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8}
}

function New-MomentBackupDialog {
    param([string]$Destination,[scriptblock]$ExportAction,[string]$StatusPath)
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $momentForm=New-Object Windows.Forms.Form
    $momentForm.Text='此刻 - 证书加密备份'
    $momentForm.ClientSize=New-Object Drawing.Size(530,335)
    $momentForm.FormBorderStyle=[Windows.Forms.FormBorderStyle]::FixedDialog
    $momentForm.StartPosition=[Windows.Forms.FormStartPosition]::CenterScreen
    $momentForm.MaximizeBox=$false
    $momentForm.MinimizeBox=$false
    $momentForm.TopMost=$true
    $momentForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
    $momentInstructions=New-Object Windows.Forms.Label
    $momentInstructions.SetBounds(20,15,490,48)
    $momentInstructions.Text="输入一组新的备份密码，并自行保管。`n至少12个英文、数字或符号字符；两个输入框均显示遮蔽符号。"
    $momentForm.Controls.Add($momentInstructions)
    $momentFirstLabel=New-Object Windows.Forms.Label
    $momentFirstLabel.SetBounds(20,80,100,26);$momentFirstLabel.Text='备份密码'
    $momentSecondLabel=New-Object Windows.Forms.Label
    $momentSecondLabel.SetBounds(20,120,100,26);$momentSecondLabel.Text='再次输入'
    $momentFirst=New-Object Windows.Forms.TextBox
    $momentFirst.SetBounds(130,76,375,30);$momentFirst.UseSystemPasswordChar=$true
    $momentFirst.MaxLength=256
    $momentSecond=New-Object Windows.Forms.TextBox
    $momentSecond.SetBounds(130,116,375,30);$momentSecond.UseSystemPasswordChar=$true
    $momentSecond.MaxLength=256
    $momentPathLabel=New-Object Windows.Forms.Label
    $momentPathLabel.SetBounds(20,161,490,22);$momentPathLabel.Text='备份文件（D盘）'
    $momentPath=New-Object Windows.Forms.TextBox
    $momentPath.SetBounds(20,186,485,30);$momentPath.ReadOnly=$true;$momentPath.Text=$Destination
    $momentError=New-Object Windows.Forms.Label
    $momentError.SetBounds(20,222,485,43);$momentError.ForeColor=[Drawing.Color]::Firebrick
    $momentSubmit=New-Object Windows.Forms.Button
    $momentSubmit.SetBounds(235,280,160,34);$momentSubmit.Text='生成加密备份'
    $momentCancel=New-Object Windows.Forms.Button
    $momentCancel.SetBounds(405,280,100,34);$momentCancel.Text='取消'
    foreach($momentControl in @($momentFirstLabel,$momentSecondLabel,$momentFirst,$momentSecond,$momentPathLabel,$momentPath,$momentError,$momentSubmit,$momentCancel)){$momentForm.Controls.Add($momentControl)}
    $momentForm.AcceptButton=$momentSubmit;$momentForm.CancelButton=$momentCancel
    $momentForm.Tag=[pscustomobject]@{First=$momentFirst;Second=$momentSecond;Error=$momentError;Submit=$momentSubmit;Cancel=$momentCancel;Action=$ExportAction;StatusPath=$StatusPath;Succeeded=$false;Exporting=$false}
    $momentForm.Add_Shown({param($sender,$eventArgs) Write-MomentBackupUiStatus $sender.Tag.StatusPath 'PasswordDialogReady'})
    $momentCancel.Add_Click({param($sender,$eventArgs) $sender.FindForm().Close()})
    $momentSubmit.Add_Click({
        param($sender,$eventArgs)
        $momentWindow=$sender.FindForm();$momentContext=$momentWindow.Tag
        $momentCode=Get-MomentBackupValidationError $momentContext.First.Text $momentContext.Second.Text
        if($momentCode){
            $momentContext.Error.Text=switch($momentCode){'PasswordTooShort'{'密码至少需要12个字符，且不能全为空格。'}'PasswordMustBeAscii'{'请使用英文、数字或符号，以兼容证书备份格式。'}'PasswordMismatch'{'两次输入不同，请重新确认。'}}
            Write-MomentBackupUiStatus $momentContext.StatusPath 'ValidationFailed' $momentCode
            return
        }
        $momentSecret=ConvertTo-SecureString $momentContext.First.Text -AsPlainText -Force
        $momentContext.First.Clear();$momentContext.Second.Clear()
        $momentContext.Submit.Enabled=$false;$momentContext.Cancel.Enabled=$false
        $momentContext.Exporting=$true;$momentWindow.UseWaitCursor=$true
        $momentContext.Error.Text='正在生成并验证备份，请稍候。'
        Write-MomentBackupUiStatus $momentContext.StatusPath 'Exporting'
        try{
            & $momentContext.Action $momentSecret | Out-Null
            $momentContext.Succeeded=$true
            Write-MomentBackupUiStatus $momentContext.StatusPath 'Succeeded'
            $momentContext.Exporting=$false
            $momentWindow.DialogResult=[Windows.Forms.DialogResult]::OK
            $momentWindow.Close()
        }catch{
            # Fixed error codes only. Do not show exception text, which could
            # contain native program output or user-supplied values.
            $momentSafeCodes=@('BackupDestinationInvalid','BackupDestinationExists','BackupDirectoryMissing','BackupImportFailed','BackupPasswordVerificationFailed','BackupCertificateMismatch','SourceSigningKeyChanged')
            $momentCode=if($_.Exception.Message -in $momentSafeCodes){$_.Exception.Message}else{'BackupExportFailed'}
            $momentContext.Error.Text="备份未完成（$momentCode）。输入已清空，请等待排查。"
            Write-MomentBackupUiStatus $momentContext.StatusPath 'ExportFailed' $momentCode
        }finally{
            $momentSecret.Dispose();$momentContext.Exporting=$false
            $momentWindow.UseWaitCursor=$false;$momentContext.Submit.Enabled=$true;$momentContext.Cancel.Enabled=$true
        }
    })
    $momentForm.Add_FormClosing({param($sender,$eventArgs) if($sender.Tag.Exporting){$eventArgs.Cancel=$true}})
    return $momentForm
}

function Show-MomentBackupDialog {
    param([string]$Destination,[scriptblock]$ExportAction,[string]$StatusPath)
    $momentDialog=New-MomentBackupDialog -Destination $Destination -ExportAction $ExportAction -StatusPath $StatusPath
    try{
        Write-MomentBackupUiStatus $StatusPath 'OpeningDialog'
        [void]$momentDialog.ShowDialog()
        if(-not $momentDialog.Tag.Succeeded){Write-MomentBackupUiStatus $StatusPath 'Cancelled';return $false}
        [void][Windows.Forms.MessageBox]::Show('已生成并验证加密备份。请自行保管备份文件和密码。','此刻 - 备份成功',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Information)
        return $true
    }finally{$momentDialog.Tag.First.Clear();$momentDialog.Tag.Second.Clear();$momentDialog.Dispose()}
}
