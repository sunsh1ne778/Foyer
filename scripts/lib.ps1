# Shared helpers for Foyer dev scripts.

$Script:FoyerRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Script:DeployDir = Join-Path $FoyerRoot "deploy"
$Script:ServerDir = Join-Path $FoyerRoot "server"
$Script:WebDir = Join-Path $FoyerRoot "web"
$Script:ConfigPath = Join-Path $FoyerRoot "configs\server.yml"
$Script:EnvPath = Join-Path $FoyerRoot "configs\.env"
$Script:EnvExample = Join-Path $FoyerRoot "configs\env.example"

$Script:ApiPorts = @(8090, 8091)
$Script:WebPort = 3000

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
    Write-Host "!! $Message" -ForegroundColor Yellow
}

function Ensure-ConfigEnv {
    if (-not (Test-Path $Script:EnvPath)) {
        if (Test-Path $Script:EnvExample) {
            Write-Warn "configs/.env missing; copied from env.example"
            Copy-Item $Script:EnvExample $Script:EnvPath
        } else {
            throw "missing configs/.env and configs/env.example"
        }
    }
}

function Get-ListenersOnPort([int]$Port) {
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $lines = netstat -ano | Select-String ":$Port\s+.*LISTENING"
        foreach ($line in $lines) {
            if ($line -match '\s+(\d+)\s*$') {
                $pids += [int]$Matches[1]
            }
        }
        $pids = @($pids | Select-Object -Unique)
    }
    return @($pids | Where-Object { $_ -gt 0 })
}

function Stop-PortListeners([int[]]$Ports) {
    foreach ($port in $Ports) {
        foreach ($procId in (Get-ListenersOnPort $port)) {
            try {
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Host "  stop PID $procId ($($proc.ProcessName)) on port $port"
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                }
            } catch {
                Write-Warn "could not stop PID $procId on port ${port}: $_"
            }
        }
    }
}

function Test-PortListening([int]$Port) {
    return (@(Get-ListenersOnPort $Port)).Count -gt 0
}

function Start-DockerInfra {
    Write-Step "docker compose up (postgres, redis, rustfs)"
    Push-Location $Script:DeployDir
    try {
        docker compose up -d postgres redis rustfs
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
}

function Stop-DockerInfra {
    Write-Step "docker compose stop (postgres, redis, rustfs)"
    Push-Location $Script:DeployDir
    try {
        docker compose stop postgres redis rustfs 2>$null
    } finally {
        Pop-Location
    }
}

function Start-ApiServer {
    if (Test-PortListening 8090) {
        Write-Warn "8090 already in use; skip API (run stop-dev.ps1 to restart)"
        return
    }
    Ensure-ConfigEnv
    Write-Step "start Go API in new window (:8090 / :8091)"
    $runner = Join-Path $PSScriptRoot "run-api.ps1"
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-File", $runner) | Out-Null
}

function Start-WebDev {
    if (Test-PortListening $Script:WebPort) {
        Write-Warn "port $($Script:WebPort) already in use; skip web"
        return
    }
    Write-Step "start Vite web in new window (http://localhost:$($Script:WebPort))"
    $runner = Join-Path $PSScriptRoot "run-web.ps1"
    Start-Process powershell.exe -ArgumentList @("-NoExit", "-File", $runner) | Out-Null
}

function Wait-ApiHealthy([int]$Seconds = 45) {
    Write-Step "wait for /v1/health..."
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:8090/v1/health" -TimeoutSec 2
            if ($r.ok -eq $true) {
                Write-Host "  API ready" -ForegroundColor Green
                return $true
            }
        } catch {
            # retry
        }
        Start-Sleep -Seconds 1
    }
    Write-Warn "API not healthy within ${Seconds}s; check API window"
    return $false
}
