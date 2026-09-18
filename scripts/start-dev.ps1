param(
    [switch]$InfraOnly,
    [switch]$NoDocker,
    [switch]$NoWeb,
    [switch]$NoApi,
    [switch]$WaitHealth
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib.ps1"

Write-Host ""
Write-Host "Foyer start" -ForegroundColor Green
Write-Host "root: $Script:FoyerRoot"
Write-Host ""

if (-not $NoDocker) {
    Start-DockerInfra
} else {
    Write-Warn "skip docker (-NoDocker)"
}

if ($InfraOnly) {
    Write-Step "done (-InfraOnly)"
    exit 0
}

if (-not $NoApi) {
    Start-ApiServer
    if ($WaitHealth) {
        Wait-ApiHealthy | Out-Null
    }
}

if (-not $NoWeb) {
    Start-Sleep -Seconds 1
    Start-WebDev
}

Write-Host ""
Write-Step "done"
Write-Host "  API: http://127.0.0.1:8090/v1/health"
Write-Host "  Web: http://localhost:$($Script:WebPort)  (admin / changeme)"
Write-Host "  stop: .\scripts\stop-dev.ps1"
Write-Host ""
