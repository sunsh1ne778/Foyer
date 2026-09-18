$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib.ps1"
Set-Location $Script:WebDir
if (-not (Test-Path "node_modules")) {
    npm install --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
npm run dev
