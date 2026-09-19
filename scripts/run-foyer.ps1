$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
git submodule update --init --recursive
& (Join-Path $PSScriptRoot "gen-host-drives.ps1")
docker compose -f deploy/compose.yml -f deploy/compose.host-drives.yml --profile juicefs up --build
