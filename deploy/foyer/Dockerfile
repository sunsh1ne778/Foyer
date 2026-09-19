FROM golang:1.23-bookworm AS build
# goproxy.cn: proxy.golang.org zip downloads hit unexpected EOF in this environment
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /src
COPY third_party/juicefs /src/juicefs
COPY overlays/juicefs /tmp/overlays/juicefs
COPY scripts/apply-juicefs-overlay.sh /tmp/apply-juicefs-overlay.sh
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends gcc libfuse3-dev python3 \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/\r$//' /tmp/apply-juicefs-overlay.sh \
    && sh /tmp/apply-juicefs-overlay.sh /tmp/overlays/juicefs /src/juicefs
WORKDIR /src/juicefs
ENV CGO_ENABLED=1
RUN go build -o /out/juicefs .

WORKDIR /src/foyer
COPY server /src/foyer
WORKDIR /src/foyer
# server/go.mod requires go 1.25; image is 1.23 per brief
ENV GOTOOLCHAIN=auto
RUN go build -o /out/foyer ./cmd/foyer

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/juicefs /usr/local/bin/juicefs
COPY --from=build /out/foyer /usr/local/bin/foyer
ENV FOYER_JUICEFS_BIN=/usr/local/bin/juicefs
ENTRYPOINT ["/usr/local/bin/foyer"]
