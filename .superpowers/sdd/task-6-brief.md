### Task 6: Docker image + compose profile `juicefs`

**Files:**
- Create: `deploy/foyer/Dockerfile`
- Create: `scripts/run-foyer.ps1`
- Modify: `deploy/compose.yml` (`rustfs-init` create `jfs` bucket; add `foyer` service)

**Interfaces:**
- Consumes: Task 4 binary, Task 5 overlay, Task 1 submodule
- Produces: `docker compose --profile juicefs up` with Gateway on host `19002` and health on host `8092`

Dockerfile (build context = **repository root**):

```dockerfile
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY third_party/juicefs /src/juicefs
COPY overlays/juicefs/pkg/object/fastdfs.go /src/juicefs/pkg/object/fastdfs.go
WORKDIR /src/juicefs
ENV CGO_ENABLED=0
RUN go build -o /out/juicefs .

WORKDIR /src/foyer
COPY server /src/foyer
WORKDIR /src/foyer
RUN go build -o /out/foyer ./cmd/foyer

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/juicefs /usr/local/bin/juicefs
COPY --from=build /out/foyer /usr/local/bin/foyer
ENV FOYER_JUICEFS_BIN=/usr/local/bin/juicefs
ENTRYPOINT ["/usr/local/bin/foyer"]
```

If `go build` of juicefs fails with CGO/fuse: set `CGO_ENABLED=1`, `apt-get install gcc libfuse3-dev` in the build stage, and keep gateway (do not pass `-tags nogateway`).

`rustfs-init` command becomes:

```yaml
        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
          aws --endpoint-url http://rustfs:9000 s3 mb s3://filestore && break
          sleep 3
        done
        aws --endpoint-url http://rustfs:9000 s3 mb s3://jfs || true
        true
```

Add service (same file, after `rustfs-init`):

```yaml
  foyer:
    profiles: ["juicefs"]
    build:
      context: ..
      dockerfile: deploy/foyer/Dockerfile
    ports:
      - "19002:9002"
      - "8092:8092"
    environment:
      FOYER_META_URL: redis://redis:6379/1
      FOYER_STORAGE: minio
      FOYER_BUCKET: http://rustfs:9000/jfs
      FOYER_ACCESS_KEY: rustfsadmin
      FOYER_SECRET_KEY: rustfsadmin
      FOYER_GATEWAY_LISTEN: "0.0.0.0:9002"
      FOYER_ADMIN_LISTEN: ":8092"
      FOYER_VOLUME: foyer
      FOYER_JUICEFS_BIN: /usr/local/bin/juicefs
      MINIO_ROOT_USER: foyerak
      MINIO_ROOT_PASSWORD: foyersecret
    depends_on:
      redis:
        condition: service_healthy
      rustfs:
        condition: service_started
      rustfs-init:
        condition: service_completed_successfully
```

If `rustfs-init` has no `service_completed_successfully` (no `restart: on-failure` and it exits 0), keep that condition. If compose version complains, use `depends_on: [redis, rustfs, rustfs-init]` without condition on init.

`scripts/run-foyer.ps1`:

```powershell
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
git submodule update --init --recursive
docker compose -f deploy/compose.yml --profile juicefs up --build
```

- [ ] **Step 1: Add Dockerfile, compose edits, run-foyer.ps1** as specified.

- [ ] **Step 2: Build image (network required)**

```powershell
git submodule update --init --recursive
docker compose -f deploy/compose.yml --profile juicefs build foyer
```

Expected: image build success. If JuiceFS compile fails, apply the CGO/fuse fallback in the Dockerfile and rebuild.

- [ ] **Step 3: Up and health**

```powershell
docker compose -f deploy/compose.yml --profile juicefs up -d foyer
curl.exe http://127.0.0.1:8092/foyer/health
```

Expected: JSON with `"ok":true`. Gateway logs should not fatal on format (first start formats; second start skips).

- [ ] **Step 4: Commit (optional)**

```powershell
git add deploy/foyer/Dockerfile deploy/compose.yml scripts/run-foyer.ps1
git commit -m "feat: compose JuiceFS S3 gateway behind foyer supervisor"
```

---

