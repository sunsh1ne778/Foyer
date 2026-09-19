# Task 7 Report: README verification (aws/mc)

## Status

**DONE.** README appended with JuiceFS section after「本地开发」; existing API/Web docs unchanged. Live gateway on `http://127.0.0.1:19002` verified with AWS CLI put/get roundtrip. **No commit.**

## Roundtrip hello

**Worked.** `Get-Content hello-back-native.txt` printed `hello` (ASCII line from `echo hello | Out-File -Encoding ascii`).

Bucket name **`foyer`** matches `FOYER_VOLUME` / gateway default; `s3://foyer/hello.txt` succeeded without workarounds.

## Health (pre-check)

```text
curl.exe http://127.0.0.1:8092/foyer/health
{"gateway":"0.0.0.0:9002","meta":"redis://redis:6379/1","ok":true,"volume":"foyer"}
```

Gateway root `http://127.0.0.1:19002` returned HTTP **403** (expected without signed request).

## AWS CLI environment

- Host had no `aws` on PATH initially; installed **Amazon.AWSCLI 2.36.48** via `winget` for README-faithful commands against `127.0.0.1:19002`.
- Prior smoke test via `docker run ... amazon/aws-cli --endpoint-url http://host.docker.internal:19002` also succeeded (same bucket/object); report below is **native** output only.

## Exact native AWS CLI output

Commands (PowerShell, repo root):

```powershell
$env:AWS_ACCESS_KEY_ID = "foyerak"
$env:AWS_SECRET_ACCESS_KEY = "foyersecret"
$env:AWS_DEFAULT_REGION = "us-east-1"
echo hello | Out-File -Encoding ascii hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 mb s3://foyer
aws --endpoint-url http://127.0.0.1:19002 s3 cp hello.txt s3://foyer/hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 cp s3://foyer/hello.txt hello-back-native.txt
Get-Content hello-back-native.txt
```

**Stdout/stderr (success):**

```text
make_bucket: foyer
Completed 7 Bytes/7 Bytes (116 Bytes/s) with 1 file(s) remaining
upload: .\hello.txt to s3://foyer/hello.txt
Completed 7 Bytes/7 Bytes (399 Bytes/s) with 1 file(s) remaining
download: s3://foyer/hello.txt to .\hello-back-native.txt
hello
```

**Note:** Re-running `s3 mb s3://foyer` after the bucket exists still printed `make_bucket: foyer` in this stack (no “already exists” error). README keeps the brief’s `mb` + `cp` sequence; if another environment returns “already exists”, skip to `cp` as documented.

## README changes

- **File:** `README.md`
- **Placement:** new `## JuiceFS 发行版（第一期）` after「本地开发」(`docker compose --profile app`), before「职责边界」.
- **Content:** matches task brief verbatim (ports `19002` / `8092`, keys `foyerak` / `foyersecret`, `s3://foyer/...`, `mc` alias line).

## Task 6 cross-check

Object storage path in foyer logs: `minio://http://rustfs:9000/jfs/jfs/foyer/` (RustFS bucket `jfs` for JuiceFS metadata). S3 **client** bucket for gateway uploads remains **`foyer`** via `http://127.0.0.1:19002`.

## `mc`

Not executed on this host (`mc` not verified). README documents alias + `mc cp hello.txt foyer/foyer/hello.txt` per brief.

## Commits

None.

## Artifacts

Test files at repo root: `hello.txt`, `hello-back.txt`, `hello-back-native.txt` (untracked; not committed).
