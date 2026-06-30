# opencore Gateway - container image for 24/7 deployment on a server/VPS.
#
# Bundles opencode + opencore's config (agents, plugins, skills) + the Telegram
# gateway. The gateway is the main process; it starts its own `opencode serve`
# internally. Use this when you want opencore available independent of your PC.
#
# Secrets (provider API key, Telegram token) are injected at runtime via env
# vars / .env - never baked into the image. See docker-compose.yml.

# Bun base: opencode's plugins run under Bun (bun:sqlite for memory/RAG), and
# Bun ships Node-compatible tooling. We add Node/npm for the global install.
FROM oven/bun:1-debian

# Node + npm (for `npm install -g opencode-ai`) and git (opencode uses it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install opencode globally.
RUN npm install -g opencode-ai@1.17.11

# --- opencore config (agents, plugins, skills) into the global opencode config ---
# opencode reads ~/.config/opencode. In the container we run as a fixed user.
ENV HOME=/home/opencore
RUN useradd -m -d /home/opencore -s /bin/bash opencore
WORKDIR /app

# Gateway deps first (better layer caching).
COPY gateway/package.json gateway/package-lock.json* ./gateway/
RUN cd gateway && npm ci

# Gateway source + build.
COPY gateway/tsconfig.json ./gateway/
COPY gateway/src ./gateway/src
RUN cd gateway && npx tsc -p tsconfig.json && npm prune --omit=dev

# opencore config: agents, plugins, skills -> ~/.config/opencode
COPY .opencode/agents /home/opencore/.config/opencode/agents
COPY .opencode/plugins /home/opencore/.config/opencode/plugins
COPY .opencode/skills /home/opencore/.config/opencode/skills
COPY .opencode/package.json .opencode/package-lock.json /home/opencore/.config/opencode/

# Plugin dependency (@opencode-ai/plugin) so plugins load.
RUN cd /home/opencore/.config/opencode && npm ci --omit=dev

# A minimal global opencode.json: default agent + hardened permissions + MCP.
# The provider/model is supplied at runtime via env (OPENCODE config or env).
COPY gateway/docker/opencode.global.json /home/opencore/.config/opencode/opencode.json

RUN chown -R opencore:opencore /home/opencore /app

USER opencore

# The workdir the agent operates in (mount your project here if desired).
ENV OPENCORE_GATEWAY_WORKDIR=/work
ENV OPENCORE_STATE_DIR=/home/opencore/.opencore
RUN mkdir -p /work

# Default agent for remote use: chat (no shell). Override via env if you accept
# the risk of remote code execution.
ENV OPENCORE_GATEWAY_DEFAULT_AGENT=chat
ENV OPENCORE_GATEWAY_PORT=4099

# Persist opencore state (memory, gateway allowlist) on a volume.
VOLUME ["/home/opencore/.opencore"]

CMD ["node", "gateway/dist/index.js"]
