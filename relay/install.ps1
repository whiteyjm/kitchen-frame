# Installs the kitchen Coles relay on this Windows logon.
# From C:\kitchen-frame:
#   powershell -ExecutionPolicy Bypass -File .\relay\install.ps1
# Then set WORKER_URL in relay\.env to the dashboard origin and start the task
# (or reboot). Node.js 18 or newer must be on PATH. The script never prints RELAY_KEY.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
Set-Location $dir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'Install Node.js 18 or newer, then run this again.'; exit 1 }

$exe = Join-Path $dir 'cloudflared.exe'
if (-not (Test-Path $exe)) {
  Write-Host 'Downloading cloudflared.exe'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
}

$envFile = Join-Path $dir '.env'
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile) }
$hasKey = $lines | Where-Object { $_ -match '^RELAY_KEY=.+' }
if (-not $hasKey) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes)
  $lines += ('RELAY_KEY=' + $key)
  Write-Host 'Wrote RELAY_KEY to relay\.env'
} else {
  Write-Host 'RELAY_KEY already set in relay\.env'
}
if (-not ($lines | Where-Object { $_ -match '^WORKER_URL=' })) {
  $lines += 'WORKER_URL=https://photo-frame-dashboard.example.workers.dev'
  Write-Host 'Added WORKER_URL to relay\.env. Change it to the dashboard origin before starting.'
}
if (-not ($lines | Where-Object { $_ -match '^PORT=' })) { $lines += 'PORT=8787' }
Set-Content -Path $envFile -Value $lines -Encoding ascii

$action = New-ScheduledTaskAction -Execute $node.Source -Argument 'server.js' -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'KitchenFrameRelay' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host 'Registered scheduled task KitchenFrameRelay (at logon, restart on failure).'
Write-Host 'Set the same RELAY_KEY with: npx wrangler secret put RELAY_KEY'
Write-Host 'Start it now with: Start-ScheduledTask -TaskName KitchenFrameRelay'
