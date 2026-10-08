# Daily data refresh via Windows Task Scheduler: fetch-tide, fetch-news, then enrich-reports; logs in data/logs/.
#   Register (run once, by the user):  powershell -ExecutionPolicy Bypass -File scripts\register-cron.ps1 [-Time 06:30]
#   Remove:                            schtasks /Delete /TN HcmFlood-daily /F
# The task runs this same script with -Run under the current user, so user env vars set with `setx`
# (ANTHROPIC_API_KEY, optional SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) are visible to it. enrich-reports is a
# no-op without the Supabase pair.
param(
  [switch]$Run,
  [string]$Time = '06:30'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'HcmFlood-daily'

if ($Run) {
  $logDir = Join-Path $root 'data\logs'
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $log = Join-Path $logDir ("{0:yyyy-MM-dd}.log" -f (Get-Date))
  Set-Location $root
  $failed = $false
  foreach ($script in 'fetch-tide.mjs', 'fetch-news.mjs', 'enrich-reports.mjs') {
    "=== $script $(Get-Date -Format s)" | Out-File -Append -Encoding utf8 $log
    & node "scripts\$script" *>&1 | Out-File -Append -Encoding utf8 $log
    if ($LASTEXITCODE -ne 0) { $failed = $true; "!!! $script exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 $log }
  }
  if ($failed) { exit 1 }
  exit 0
}

$command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Run"
schtasks /Create /TN $taskName /SC DAILY /ST $Time /TR $command /F
if ($LASTEXITCODE -ne 0) { throw "schtasks failed ($LASTEXITCODE)" }
Write-Host "Registered '$taskName' daily at $Time. Logs: $(Join-Path $root 'data\logs')"
