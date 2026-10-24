# Elevated runners with WebView2 >=150 ignore environment/HKCU flag overrides.
# Use a temporary per-executable HKLM override only on the disposable CI host:
# https://learn.microsoft.com/microsoft-edge/webview2/concepts/security
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:MOMENT_ALLOW_INSTALLER_QA -ne '1' -or [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE) -ne $momentProjectRoot){throw 'Runtime inspection is restricted to the disposable CI runner'}
$momentRuntimeOut=Join-Path $momentCacheRoot 'windows-installer-evidence'
New-Item -ItemType Directory -Force -Path $momentRuntimeOut | Out-Null
$momentPolicyBase='HKLM:\Software\Policies\Microsoft\Edge\WebView2'
$momentPolicies=@{
    AdditionalBrowserArguments=('--remote-debugging-port=9225 --enable-logging --log-file="'+(Join-Path $momentRuntimeOut 'webview-runtime.log')+'"')
    UserDataFolder=(Join-Path $momentRuntimeOut 'release-webview')
}
$momentPrevious=@{}
try {
    foreach($momentKind in $momentPolicies.Keys){
        $momentKey=Join-Path $momentPolicyBase $momentKind
        New-Item -Path $momentKey -Force | Out-Null
        $momentPrevious[$momentKind]=(Get-ItemProperty -LiteralPath $momentKey -Name 'schedule-app.exe' -ErrorAction SilentlyContinue).'schedule-app.exe'
        New-ItemProperty -LiteralPath $momentKey -Name 'schedule-app.exe' -Value $momentPolicies[$momentKind] -PropertyType String -Force | Out-Null
    }
    & node (Join-Path $PSScriptRoot 'windows-release-runtime.cjs')
    if($LASTEXITCODE -ne 0){throw 'Optimized Windows runtime verification failed'}
} finally {
    foreach($momentKind in $momentPrevious.Keys){
        $momentKey=Join-Path $momentPolicyBase $momentKind
        if($null -eq $momentPrevious[$momentKind]){Remove-ItemProperty -LiteralPath $momentKey -Name 'schedule-app.exe' -ErrorAction SilentlyContinue}
        else{Set-ItemProperty -LiteralPath $momentKey -Name 'schedule-app.exe' -Value $momentPrevious[$momentKind]}
    }
}
