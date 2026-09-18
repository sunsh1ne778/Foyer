param(
    [switch]$IncludeDocker
)

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\lib.ps1"

Write-Host ""
Write-Host "Foyer stop" -ForegroundColor Yellow
Write-Host ""

Write-Step "free API ports $($Script:ApiPorts -join ', ')"
Stop-PortListeners -Ports $Script:ApiPorts

Write-Step "free web port $($Script:WebPort)"
Stop-PortListeners -Ports @($Script:WebPort)

if ($IncludeDocker) {
    Stop-DockerInfra
} else {
    Write-Host "  docker still running (use -IncludeDocker to stop)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Step "stopped"
Write-Host ""
