# Removes the KitchenFrameRelay scheduled task. Leaves relay\.env and cloudflared.exe in place.
$ErrorActionPreference = 'Continue'
Stop-ScheduledTask -TaskName 'KitchenFrameRelay' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'KitchenFrameRelay' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Removed scheduled task KitchenFrameRelay.'
