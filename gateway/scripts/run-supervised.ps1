# opencore Gateway supervisor loop.
# Runs the gateway and restarts it on crash with exponential backoff.
# Logs to ~/.opencore/gateway/daemon.log. Writes its own PID for control scripts.
#
# Not meant to be called directly - use daemon.ps1 (install/start/stop/status).

$ErrorActionPreference = "Stop"

$gatewayDir = Split-Path -Parent $PSScriptRoot   # ...\gateway
$stateDir = Join-Path $HOME ".opencore\gateway"
$logFile = Join-Path $stateDir "daemon.log"
$pidFile = Join-Path $stateDir "daemon.pid"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$PID | Set-Content $pidFile

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss"), $msg
  Add-Content -Path $logFile -Value $line
}

# Prefer the compiled build; fall back to tsx for dev convenience.
$entryJs = Join-Path $gatewayDir "dist\index.js"
$useBuild = Test-Path $entryJs

Log "supervisor starting (build=$useBuild) dir=$gatewayDir"

$maxRestarts = 10        # within the rolling window
$windowSeconds = 60
$restartTimes = New-Object System.Collections.Generic.Queue[datetime]

while ($true) {
  $start = Get-Date
  try {
    if ($useBuild) {
      & node $entryJs 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ }
    } else {
      Push-Location $gatewayDir
      & npx tsx src/index.ts 2>&1 | ForEach-Object { Add-Content -Path $logFile -Value $_ }
      Pop-Location
    }
  } catch {
    Log "gateway threw: $($_.Exception.Message)"
  }

  $exitCode = $LASTEXITCODE
  Log "gateway exited (code=$exitCode); evaluating restart"

  # rolling-window restart throttle
  $now = Get-Date
  $restartTimes.Enqueue($now)
  while ($restartTimes.Count -gt 0 -and ($now - $restartTimes.Peek()).TotalSeconds -gt $windowSeconds) {
    [void]$restartTimes.Dequeue()
  }
  if ($restartTimes.Count -gt $maxRestarts) {
    Log "too many restarts ($($restartTimes.Count)) in ${windowSeconds}s - giving up"
    break
  }

  # backoff based on how quickly it died
  $ranSeconds = ($now - $start).TotalSeconds
  $backoff = if ($ranSeconds -lt 5) { 5 } elseif ($ranSeconds -lt 30) { 2 } else { 1 }
  Log "restarting in ${backoff}s"
  Start-Sleep -Seconds $backoff
}

Log "supervisor stopped"
