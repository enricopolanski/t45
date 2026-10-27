# The agent image every chat boots: Node, OpenCode pinned to the server's @opencode/client release, PDF and OCR tools, a non-root
# `agent` user, and the step tools and workflow drafting tool admins give agents. The runner starts `opencode serve` itself. OpenCode
# reaches nothing at run time but its provider, so nothing is pre-warmed.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates poppler-utils tesseract-ocr tesseract-ocr-ita tesseract-ocr-deu python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @opencode/cli@2.1.4 && npm cache clean --force
# uid 1000 is node's; the agent gets its own.
RUN useradd -m -u 1001 agent && mkdir -p /work && chown agent:agent /work
COPY mcp-stdio.mjs step-tools.mjs workflow-tools.mjs /opt/t45/
USER agent
ENV HOME=/home/agent
WORKDIR /work
