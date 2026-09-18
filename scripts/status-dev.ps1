# 查看本地开发相关端口与 Docker 状态

. "$PSScriptRoot\lib.ps1"

Write-Host ""
Write-Host "Foyer dev status" -ForegroundColor Cyan
Write-Host ""

foreach ($port in ($Script:ApiPorts + @($Script:WebPort))) {
    $pids = Get-ListenersOnPort $port
    if ($pids.Count -eq 0) {
        Write-Host "  port $port : free"
    } else {
        foreach ($procId in $pids) {
            $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
            Write-Host "  port $port : listening (PID $procId $name)"
        }
    }
}

Write-Host ""
Write-Step "Docker (deploy/)"
Push-Location $Script:DeployDir
docker compose ps postgres redis rustfs 2>$null
Pop-Location

Write-Host ""
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:8090/v1/health" -TimeoutSec 2
    Write-Host "  /v1/health ok=$($h.ok)" -ForegroundColor Green
} catch {
    Write-Host "  /v1/health unreachable" -ForegroundColor DarkYellow
}
Write-Host ""
