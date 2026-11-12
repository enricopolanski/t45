# The agent image every chat boots: Node, OpenCode pinned to the server's @opencode/client release, PDF and OCR tools,
# Playwright CLI with Chrome for Testing for agents that browse, a non-root `agent` user. T45 supplies MCP tools with
# each boot. The runner starts `opencode serve` itself. OpenCode reaches nothing at run time but its provider, so
# nothing is pre-warmed.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates poppler-utils tesseract-ocr tesseract-ocr-ita tesseract-ocr-deu python3 libnss3-tools \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @opencode/cli@2.1.4 @playwright/cli@0.1.24 && npm cache clean --force
# Outside any home, so the agent user finds it. Playwright CLI otherwise opens Google Chrome, which isn't installed.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright PLAYWRIGHT_MCP_BROWSER=chromium NO_UPDATE_NOTIFIER=1
RUN playwright-cli install-browser chromium --no-shell --with-deps && rm -rf /var/lib/apt/lists/*
# uid 1000 is node's; the agent gets its own.
RUN useradd -m -u 1001 agent && mkdir -p /work && chown agent:agent /work
USER agent
ENV HOME=/home/agent
WORKDIR /work
