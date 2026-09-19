$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "overlays\juicefs"
$dst = Join-Path $root "third_party\juicefs"
if (-not (Test-Path $dst)) { throw "missing submodule $dst" }

Copy-Item -Path (Join-Path $src "pkg\object\fastdfs.go") -Destination (Join-Path $dst "pkg\object\fastdfs.go") -Force
Copy-Item -Path (Join-Path $src "pkg\object\fastdfs_test.go") -Destination (Join-Path $dst "pkg\object\fastdfs_test.go") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $dst "pkg\vfs") | Out-Null
Copy-Item -Path (Join-Path $src "pkg\vfs\compat.go") -Destination (Join-Path $dst "pkg\vfs\compat.go") -Force
Copy-Item -Path (Join-Path $src "pkg\vfs\compat_test.go") -Destination (Join-Path $dst "pkg\vfs\compat_test.go") -Force
Copy-Item -Path (Join-Path $src "cmd\import.go") -Destination (Join-Path $dst "cmd\import.go") -Force
Copy-Item -Path (Join-Path $src "cmd\import_test.go") -Destination (Join-Path $dst "cmd\import_test.go") -Force
Copy-Item -Path (Join-Path $src "cmd\stat.go") -Destination (Join-Path $dst "cmd\stat.go") -Force
Copy-Item -Path (Join-Path $src "cmd\stat_test.go") -Destination (Join-Path $dst "cmd\stat_test.go") -Force

$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = Join-Path $dst "pkg\vfs\reader.go"
$r = [IO.File]::ReadAllText($reader)
if ($r -notmatch "tryOpenCompat") {
  $r2 = [regex]::Replace($r, 'func \(r \*dataReader\) Open\(inode Ino, length uint64\) FileReader \{\r?\n\tf := &fileReader\{', "func (r *dataReader) Open(inode Ino, length uint64) FileReader {`n`tif f := tryOpenCompat(r.m, inode, length); f != nil {`n`t`treturn f`n`t}`n`tf := &fileReader{", 1)
  if ($r2 -eq $r) { throw "reader.go Open() hook site not found" }
  [IO.File]::WriteAllText($reader, $r2, $utf8)
}

$main = Join-Path $dst "cmd\main.go"
$m = [IO.File]::ReadAllText($main)
# 必须带上 "()," 精确匹配：main.go 里已有 cmdStatus() / cmdStats()，裸 cmdStat 会误判。
if ($m -notmatch 'cmdImport\(\),') {
  $m2 = [regex]::Replace($m, '\t\t\tcmdSync\(\),\r?\n', "`t`t`tcmdSync(),`n`t`t`tcmdImport(),`n", 1)
  if ($m2 -eq $m) { throw "main.go cmdSync() hook site not found" }
  $m = $m2
}
if ($m -notmatch 'cmdStat\(\),') {
  $m2 = [regex]::Replace($m, '\t\t\tcmdImport\(\),\r?\n', "`t`t`tcmdImport(),`n`t`t`tcmdStat(),`n", 1)
  if ($m2 -eq $m) { throw "main.go cmdImport() hook site not found" }
  $m = $m2
}
[IO.File]::WriteAllText($main, $m, $utf8)

Write-Host "overlay applied"
