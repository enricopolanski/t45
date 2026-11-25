# The agent image every chat boots: Node, OpenCode pinned to the server's @opencode/client release, PDF and OCR tools, openpyxl for Excel files,
# Playwright CLI and Chromium for agents that browse, and a non-root `agent` user. Capabilities supply MCP tools with
# each boot. The runner starts `opencode serve` itself. OpenCode reaches nothing at run time but its provider, so
# nothing is pre-warmed. The Cloudflare runner uses the same image; its file helpers need the sandbox shim, whose tag
# must equal the installed @cloudflare/sandbox version.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-liberation libnss3-tools poppler-utils tesseract-ocr tesseract-ocr-ita \
      tesseract-ocr-deu python3 python3-openpyxl \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @opencode/cli@2.1.4 @playwright/cli@0.1.24 && npm cache clean --force
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Playwright CLI otherwise looks for a newer release on every command.
ENV NO_UPDATE_NOTIFIER=1
# uid 1000 is node's; the agent gets its own, and writes its capability files itself on Cloudflare.
RUN useradd -m -u 1001 agent && mkdir -p /work /opt/t45 && chown agent:agent /work /opt/t45
USER agent
ENV HOME=/home/agent
WORKDIR /work
# Cloudflare keeps a container running only while its main process does.
CMD ["sleep", "infinity"]
