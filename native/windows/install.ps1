# Cove Server for Windows: install or update (run as administrator; "Install Cove Server.cmd" does that for you)
# -Quiet: no browser, no "Press Enter" at the end (for scripted installs)
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
# keep the window open and say what went wrong, with a log in ProgramData\Cove Server
$logDir = Join-Path $env:ProgramData 'Cove Server'; New-Item -ItemType Directory -Force $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir 'install-log.txt') -Force | Out-Null
trap { Write-Host ""; Write-Host "Cove Server didn't install: $_" -ForegroundColor Red; Stop-Transcript | Out-Null; if (-not $Quiet) { Write-Host "Press Enter to close."; [void](Read-Host) }; exit 1 }
$src = $PSScriptRoot
$dest = Join-Path $env:ProgramFiles 'Cove Server'
$data = Join-Path $env:ProgramData 'Cove Server'
Write-Host "Installing Cove Server..." -ForegroundColor Cyan
Get-Process CoveTray -ErrorAction SilentlyContinue | Stop-Process -Force
if (Get-Service CoveServer -ErrorAction SilentlyContinue) { Stop-Service CoveServer -Force; Start-Sleep 2 }
New-Item -ItemType Directory -Force $dest, $data | Out-Null
# Cove's keys (Jellyfin, Seerr): only the service and admins may read them, not every account on this PC
$secrets = Join-Path $data 'secrets'
New-Item -ItemType Directory -Force $secrets | Out-Null
icacls $secrets /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Copy-Item (Join-Path $src 'CoveServer.exe'), (Join-Path $src 'CoveTray.exe'), (Join-Path $src 'uninstall.ps1') $dest -Force
$exe = Join-Path $dest 'CoveServer.exe'
if (Get-Service CoveServer -ErrorAction SilentlyContinue) { Start-Service CoveServer } else { & $exe install | Out-Host }
# let devices at home reach it (home and work networks only, not public ones)
$port = 5050
$cfg = Join-Path $data 'server.json'
if (Test-Path $cfg) { try { $p = (Get-Content $cfg -Raw | ConvertFrom-Json).port; if ($p) { $port = $p } } catch {} }
Get-NetFirewallRule -DisplayName 'Cove Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Cove Server' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private,Domain | Out-Null
# tray icon for everyone who signs in to this PC
$lnk = Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'Cove Server.lnk'
$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($lnk); $s.TargetPath = Join-Path $dest 'CoveTray.exe'; $s.Save()
$menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Cove Server.lnk'
$s = $ws.CreateShortcut($menu); $s.TargetPath = Join-Path $dest 'CoveTray.exe'; $s.Save()
if (-not $Quiet) { Start-Process explorer.exe (Join-Path $dest 'CoveTray.exe') }
for ($i = 0; $i -lt 20 -and -not (Test-Path (Join-Path $data 'setup-code.txt')) -and -not (Test-Path (Join-Path $data 'people.json')); $i++) { Start-Sleep 1 }
Write-Host ""
Write-Host "Cove Server is running: http://localhost:$port" -ForegroundColor Green
$code = Join-Path $data 'setup-code.txt'
if (Test-Path $code) { Write-Host ("Setup code: " + (Get-Content $code -Raw).Trim()) -ForegroundColor Yellow; if (-not $Quiet) { Start-Process "http://localhost:$port" } }
Stop-Transcript | Out-Null
if (-not $Quiet) { Write-Host "Press Enter to close."; [void](Read-Host) }
