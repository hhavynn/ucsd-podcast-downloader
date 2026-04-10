# Registers the native messaging host with Chrome on Windows.
# Usage: .\install.ps1 -ExtensionId YOUR_EXTENSION_ID
#
# Your extension ID is the 32-character string shown under the extension
# name at chrome://extensions.

param(
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId
)

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatPath    = Join-Path $ScriptDir "host.bat"
$ManifestPath = Join-Path $ScriptDir "host_manifest_installed.json"

if (-not (Test-Path $BatPath)) {
    Write-Error "host.bat not found at $BatPath"
    exit 1
}

# Write the resolved host manifest next to the scripts.
# Chrome reads this file; the path must be absolute.
$manifest = [ordered]@{
    name            = "com.ucsd.podcast.downloader"
    description     = "UCSD Podcast Downloader native helper"
    path            = $BatPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# Use .NET directly — PowerShell 5.1's Out-File -Encoding utf8 writes a BOM
# which Chrome rejects. UTF8Encoding($false) gives BOM-free UTF-8.
$json = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding $false))

# Chrome finds Windows native hosts by looking up this registry key.
# The key name is the host name; the default value is the path to the manifest JSON.
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ucsd.podcast.downloader"
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath

Write-Host ""
Write-Host "Done. Registered native messaging host." -ForegroundColor Green
Write-Host ""
Write-Host "  Registry key : $RegKey"
Write-Host "  Manifest     : $ManifestPath"
Write-Host "  Host script  : $BatPath"
Write-Host ""
Write-Host "Now reload the extension at chrome://extensions and click 'Test Connection'."
