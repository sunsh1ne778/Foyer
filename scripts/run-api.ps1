$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib.ps1"
Ensure-ConfigEnv
Set-Location $Script:ServerDir
$env:FILESTORE_CONFIG = $Script:ConfigPath
Write-Host "FILESTORE_CONFIG=$env:FILESTORE_CONFIG"
go run ./cmd/server
