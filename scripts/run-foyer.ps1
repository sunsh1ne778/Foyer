$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
git submodule update --init --recursive
docker compose -f deploy/compose.yml --profile juicefs up --build
