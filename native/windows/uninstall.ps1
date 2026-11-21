# Cove Server for Windows: remove it. Keeps C:\ProgramData\Cove Server (settings, keys, people) unless you delete it yourself.
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
$dest = Join-Path $env:ProgramFiles 'Cove Server'
Get-Process CoveTray -ErrorAction SilentlyContinue | Stop-Process -Force
if (Get-Service CoveServer -ErrorAction SilentlyContinue) { Stop-Service CoveServer -Force; & (Join-Path $dest 'CoveServer.exe') remove | Out-Host }
Get-NetFirewallRule -DisplayName 'Cove Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'Cove Server.lnk'), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Cove Server.lnk') -ErrorAction SilentlyContinue
Start-Sleep 2
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Cove Server is removed. Your settings are still in $env:ProgramData\Cove Server." -ForegroundColor Green
if (-not $Quiet) { Write-Host "Press Enter to close."; [void](Read-Host) }
