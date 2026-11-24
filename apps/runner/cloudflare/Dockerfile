# The calculation image: Node 24 like the local agent image, a non-root `agent` user owning /work, and the
# sandbox-shim that @cloudflare/sandbox's Files runs. Keep the donor tag equal to the installed SDK version.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM --platform=linux/amd64 node:24-bookworm-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN useradd -m -u 1001 agent && mkdir -p /work && chown agent:agent /work
USER agent
ENV HOME=/home/agent
WORKDIR /work
CMD ["sleep", "infinity"]
