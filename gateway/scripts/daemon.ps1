# MOA Gateway daemon control (Windows, no admin required).
#
# Uses the per-user Startup folder so the gateway supervisor launches at logon
# without administrator rights. The supervisor (run-supervised.ps1) keeps the
# gateway alive with crash restart. Logs go to ~/.moa/gateway/daemon.log.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 uninstall
#   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 logs

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "uninstall", "start", "stop", "status", "logs")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$gatewayDir = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $gatewayDir "scripts\run-supervised.ps1"
$stateDir = Join-Path $HOME ".moa\gateway"
$logFile = Join-Path $stateDir "daemon.log"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcut = Join-Path $startupDir "MOA Gateway.lnk"
$psExe = (Get-Command powershell.exe).Source
$supervisorArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisor`""

function Test-Running {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "gateway[\\/](dist[\\/]index\.js|src[\\/]index\.ts)" }
}

function Install-Daemon {
  if (-not (Test-Path (Join-Path $gatewayDir ".env"))) {
    Write-Host "! No .env found in $gatewayDir. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN before starting." -ForegroundColor Yellow
  }
  # Create a Startup shortcut that launches the supervisor hidden at logon.
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($shortcut)
  $lnk.TargetPath = $psExe
  $lnk.Arguments = $supervisorArgs
  $lnk.WorkingDirectory = $gatewayDir
  $lnk.WindowStyle = 7  # minimized
  $lnk.Description = "MOA Gateway (Telegram) supervisor"
  $lnk.Save()
  Write-Host "Installed Startup shortcut: $shortcut"
  Write-Host "It will launch at logon. Start it now with: scripts\daemon.ps1 start"
}

function Uninstall-Daemon {
  Stop-Daemon
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
  Write-Host "Removed Startup shortcut."
}

function Start-Daemon {
  if (Test-Running) { Write-Host "Gateway already running."; return }
  Start-Process -FilePath $psExe -ArgumentList $supervisorArgs -WorkingDirectory $gatewayDir -WindowStyle Hidden
  Write-Host "Started gateway supervisor. Tail logs: scripts\daemon.ps1 logs"
}

function Stop-Daemon {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -match "run-supervised\.ps1" -or
      $_.CommandLine -match "gateway[\\/](dist[\\/]index\.js|src[\\/]index\.ts)" -or
      $_.CommandLine -match "serve --port 40"
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "Stopped gateway and supervisor."
}

function Get-Status {
  Write-Host "Startup shortcut : $(if (Test-Path $shortcut) { 'installed' } else { 'not installed' })"
  $running = Test-Running
  Write-Host ("Gateway          : {0}" -f $(if ($running) { "running (pid $(($running.ProcessId) -join ','))" } else { "not running" }))
  Write-Host "Log file         : $logFile"
}

function Show-Logs {
  if (Test-Path $logFile) { Get-Content $logFile -Tail 40 }
  else { Write-Host "No log file yet at $logFile" }
}

switch ($Action) {
  "install"   { Install-Daemon }
  "uninstall" { Uninstall-Daemon }
  "start"     { Start-Daemon }
  "stop"      { Stop-Daemon }
  "status"    { Get-Status }
  "logs"      { Show-Logs }
}
