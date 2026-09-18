$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "overlays\juicefs"
$dst = Join-Path $root "third_party\juicefs"
if (-not (Test-Path $dst)) { throw "missing submodule $dst" }
Copy-Item -Path (Join-Path $src "pkg\object\fastdfs.go") -Destination (Join-Path $dst "pkg\object\fastdfs.go") -Force
Copy-Item -Path (Join-Path $src "pkg\object\fastdfs_test.go") -Destination (Join-Path $dst "pkg\object\fastdfs_test.go") -Force
Write-Host "overlay applied"
