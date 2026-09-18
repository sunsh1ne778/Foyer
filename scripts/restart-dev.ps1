# 重启本地 API + Web（默认保留 Docker 运行）
# 用法:
#   .\scripts\restart-dev.ps1
#   .\scripts\restart-dev.ps1 -IncludeDocker   # 同时重启 Docker 基础设施

param(
    [switch]$IncludeDocker,
    [switch]$NoWeb,
    [switch]$WaitHealth
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Foyer 开发环境重启" -ForegroundColor Green
Write-Host ""

& "$PSScriptRoot\stop-dev.ps1" -IncludeDocker:$IncludeDocker

Start-Sleep -Seconds 2

$startArgs = @{}
if ($NoWeb) { $startArgs.NoWeb = $true }
if ($WaitHealth) { $startArgs.WaitHealth = $true }
if ($IncludeDocker) {
    # stop 已停 docker；start 会重新 up
} else {
    $startArgs.NoDocker = $true
}

& "$PSScriptRoot\start-dev.ps1" @startArgs
