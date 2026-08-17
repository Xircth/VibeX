# Host-family image. Build the family first:
#   node scripts/package-host-family.js ... --output dist/host-family
#   docker build --build-arg HOST_FAMILY=dist/host-family -t ghcr.io/vibex/vibex-server .
ARG HOST_FAMILY=dist/host-family
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
ARG HOST_FAMILY
COPY ${HOST_FAMILY}/vibex-server /usr/local/bin/vibex-server
COPY ${HOST_FAMILY}/vibex-mcp /usr/local/bin/vibex-mcp
COPY ${HOST_FAMILY}/web /app/web
COPY ${HOST_FAMILY}/plugins/bundled /app/plugins/bundled
ENV VIBEX_STATIC_ROOT=/app/web
ENV VIBEX_DATA_DIR=/data
ENV VIBEX_SERVER_LISTEN=127.0.0.1:3080
EXPOSE 3080
VOLUME /data
CMD ["vibex-server"]
