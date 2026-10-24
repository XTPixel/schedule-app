param(
    [Parameter(Mandatory=$true)][ValidateSet('Create','Status','Sign','ExportBackup')][string]$Mode,
    [string]$UnsignedApk,
    [string]$OutputApk,
    [string]$BackupPath,
    [string]$BackupStatusPath
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$momentSigningRoot=Join-Path $momentProjectRoot '.private/android-signing'
$momentKeystore=Join-Path $momentSigningRoot 'moment-release.p12'
$momentPasswordFile=Join-Path $momentSigningRoot 'moment-release.password.dpapi'
$momentCertificate=Join-Path $momentSigningRoot 'moment-release.crt'
$momentMetadata=Join-Path $momentSigningRoot 'certificate.json'
$momentMarker=Join-Path $momentSigningRoot '.moment-signing-root'
$momentKeytool=Join-Path $env:JAVA_HOME 'bin/keytool.exe'
$momentAlias='moment-release'
$momentSecretNames=@('MOMENT_ANDROID_STORE_PASSWORD','MOMENT_ANDROID_KEY_PASSWORD')
$momentPreviousSecrets=@{}
foreach($momentName in $momentSecretNames){$momentPreviousSecrets[$momentName]=[Environment]::GetEnvironmentVariable($momentName,'Process')}
$momentSecurePassword=$null
function Set-MomentSecretEnvironment([Security.SecureString]$Secret,[string[]]$Names){
    $momentPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try{foreach($momentName in $Names){[Environment]::SetEnvironmentVariable($momentName,[Runtime.InteropServices.Marshal]::PtrToStringBSTR($momentPointer),'Process')}}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($momentPointer)}
}
try{
    if($Mode -eq 'Create'){
        if(@($momentKeystore,$momentPasswordFile,$momentCertificate,$momentMetadata | Where-Object {Test-Path -LiteralPath $_}).Count){throw 'Signing material already exists. Never rotate or overwrite an established application certificate.'}
        if((Test-Path -LiteralPath $momentSigningRoot) -and -not (Test-Path -LiteralPath $momentMarker) -and @(Get-ChildItem -LiteralPath $momentSigningRoot -Force).Count){throw 'Refuse to change permissions on an unknown non-empty directory'}
        New-Item -ItemType Directory -Force -Path $momentSigningRoot | Out-Null
        if(Test-Path -LiteralPath $momentMarker){if((Get-Content -LiteralPath $momentMarker -Raw -Encoding UTF8) -ne 'moment-android-signing-v1'){throw 'Unknown signing directory marker'}}
        # The keystore is encrypted; restrict the directory to its Windows owner,
        # SYSTEM and local administrators as an additional filesystem boundary.
        $momentAcl=New-Object Security.AccessControl.DirectorySecurity
        $momentAcl.SetAccessRuleProtection($true,$false)
        $momentOwner=[Security.Principal.WindowsIdentity]::GetCurrent().User
        foreach($momentIdentity in @($momentOwner,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){
            $momentAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($momentIdentity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
        }
        Set-Acl -LiteralPath $momentSigningRoot -AclObject $momentAcl
        Set-Content -LiteralPath $momentMarker -Value 'moment-android-signing-v1' -NoNewline
        $momentRandom=New-Object byte[] 32
        $momentRng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try{$momentRng.GetBytes($momentRandom);$momentSecurePassword=ConvertTo-SecureString ([Convert]::ToBase64String($momentRandom)) -AsPlainText -Force}
        finally{[Array]::Clear($momentRandom,0,$momentRandom.Length);$momentRng.Dispose()}
        # ConvertFrom-SecureString without a supplied key uses current-user DPAPI.
        # No plaintext password is emitted, written to disk or placed on argv.
        ConvertFrom-SecureString $momentSecurePassword | Set-Content -LiteralPath $momentPasswordFile -NoNewline
        Set-MomentSecretEnvironment $momentSecurePassword @('MOMENT_ANDROID_STORE_PASSWORD','MOMENT_ANDROID_KEY_PASSWORD')
        & $momentKeytool -genkeypair -alias $momentAlias -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -storetype PKCS12 -keystore $momentKeystore -storepass:env MOMENT_ANDROID_STORE_PASSWORD -keypass:env MOMENT_ANDROID_KEY_PASSWORD -dname 'CN=MOMENT Android Release, OU=Mobile, O=MOMENT, C=CN'
        if($LASTEXITCODE -ne 0){throw 'Signing key creation failed; preserve partial material for inspection'}
        & $momentKeytool -exportcert -alias $momentAlias -keystore $momentKeystore -storepass:env MOMENT_ANDROID_STORE_PASSWORD -file $momentCertificate
        if($LASTEXITCODE -ne 0){throw 'Public certificate export failed'}
        $momentCert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($momentCertificate)
        $momentHasher=[Security.Cryptography.SHA256]::Create()
        try{$momentFingerprint=([BitConverter]::ToString($momentHasher.ComputeHash($momentCert.RawData))).Replace('-','').ToLowerInvariant()}
        finally{$momentHasher.Dispose()}
        [ordered]@{createdAt=[DateTime]::UtcNow.ToString('o');alias=$momentAlias;algorithm='RSA-3072 / SHA256withRSA';certificateSha256=$momentFingerprint;validUntil=$momentCert.NotAfter.ToUniversalTime().ToString('o');keystore=$momentKeystore;passwordProtection='Current Windows user DPAPI';portableBackupVerified=$false} | ConvertTo-Json | Set-Content -LiteralPath $momentMetadata -Encoding UTF8
    }else{
        if((Get-Content -LiteralPath $momentMarker -Raw -Encoding UTF8) -ne 'moment-android-signing-v1'){throw 'Signing directory marker mismatch'}
        if(-not (Test-Path -LiteralPath $momentKeystore)){throw 'Project signing key is missing'}
        $momentSecurePassword=ConvertTo-SecureString (Get-Content -LiteralPath $momentPasswordFile -Raw -Encoding UTF8)
        if($Mode -eq 'Sign'){Set-MomentSecretEnvironment $momentSecurePassword @('MOMENT_ANDROID_STORE_PASSWORD','MOMENT_ANDROID_KEY_PASSWORD')}
    }
    if($Mode -eq 'Sign'){
        if(-not (Test-Path -LiteralPath $UnsignedApk)){throw 'Unsigned APK is missing'}
        if([string]::IsNullOrWhiteSpace($OutputApk) -or -not [IO.Path]::GetFullPath($OutputApk).StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase)){throw 'Signing output must stay on D:'}
        if([IO.Path]::GetExtension($OutputApk) -ne '.apk' -or [IO.Path]::GetFullPath($UnsignedApk) -eq [IO.Path]::GetFullPath($OutputApk)){throw 'Use a separate APK output; never overwrite the signing input or key material'}
        $momentApkSigner=Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat'
        & $momentApkSigner sign --ks $momentKeystore --ks-key-alias $momentAlias --ks-pass env:MOMENT_ANDROID_STORE_PASSWORD --key-pass env:MOMENT_ANDROID_KEY_PASSWORD --v4-signing-enabled false --out $OutputApk $UnsignedApk
        if($LASTEXITCODE -ne 0){throw 'Project-certificate signing failed'}
        & $momentApkSigner verify --verbose --print-certs $OutputApk
        if($LASTEXITCODE -ne 0){throw 'Signed APK verification failed'}
    }
    if($Mode -eq 'ExportBackup'){
        if([string]::IsNullOrWhiteSpace($BackupPath) -or -not [IO.Path]::GetFullPath($BackupPath).StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase)){throw 'Choose a new backup file on D:'}
        if(Test-Path -LiteralPath $BackupPath){throw 'Never overwrite an existing key backup'}
        . (Join-Path $PSScriptRoot 'android-signing-backup.ps1')
        $momentInfo=Get-Content -LiteralPath $momentMetadata -Raw -Encoding UTF8 | ConvertFrom-Json
        $momentExportAction={
            param([Security.SecureString]$ChosenPassword)
            Export-MomentSigningBackup -Keytool $momentKeytool -Keystore $momentKeystore -Alias $momentAlias -SourcePassword $momentSecurePassword -BackupPassword $ChosenPassword -ExpectedCertificateSha256 $momentInfo.certificateSha256 -Destination $BackupPath
            $momentInfo.portableBackupVerified=$true
            $momentInfo | ConvertTo-Json | Set-Content -LiteralPath $momentMetadata -Encoding UTF8
        }
        if(-not (Show-MomentBackupDialog -Destination $BackupPath -ExportAction $momentExportAction -StatusPath $BackupStatusPath)){throw 'BackupCancelled'}
    }
    Get-Content -LiteralPath $momentMetadata -Raw -Encoding UTF8
}finally{
    foreach($momentName in $momentSecretNames){[Environment]::SetEnvironmentVariable($momentName,$momentPreviousSecrets[$momentName],'Process')}
    if($momentSecurePassword){$momentSecurePassword.Dispose()}
}
