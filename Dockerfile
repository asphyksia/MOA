# MOA Gateway - container image for 24/7 deployment on a server/VPS.
#
# Bundles opencode + MOA's config (agents, plugins, skills) + the Telegram
# gateway. The gateway is the main process; it starts its own `opencode serve`
# internally. Use this when you want MOA available independent of your PC.
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

# --- MOA config (agents, plugins, skills) into the global opencode config ---
# opencode reads ~/.config/opencode. In the container we run as a fixed user.
ENV HOME=/home/moa
RUN useradd -m -d /home/moa -s /bin/bash moa
WORKDIR /app

# Gateway deps first (better layer caching).
COPY gateway/package.json gateway/package-lock.json* ./gateway/
RUN cd gateway && npm install --omit=dev

# Gateway source + build.
COPY gateway/tsconfig.json ./gateway/
COPY gateway/src ./gateway/src
RUN cd gateway && npm install typescript && npx tsc -p tsconfig.json

# MOA config: agents, plugins, skills -> ~/.config/opencode
COPY .opencode/agents /home/moa/.config/opencode/agents
COPY .opencode/plugins /home/moa/.config/opencode/plugins
COPY .opencode/skills /home/moa/.config/opencode/skills
COPY .opencode/package.json /home/moa/.config/opencode/package.json

# Plugin dependency (@opencode-ai/plugin) so plugins load.
RUN cd /home/moa/.config/opencode && npm install

# A minimal global opencode.json: default agent + hardened permissions + MCP.
# The provider/model is supplied at runtime via env (OPENCODE config or env).
COPY gateway/docker/opencode.global.json /home/moa/.config/opencode/opencode.json

RUN chown -R moa:moa /home/moa /app

USER moa

# The workdir the agent operates in (mount your project here if desired).
ENV MOA_GATEWAY_WORKDIR=/work
RUN mkdir -p /work

# Default agent for remote use: chat (no shell). Override via env if you accept
# the risk of remote code execution.
ENV MOA_GATEWAY_DEFAULT_AGENT=chat
ENV MOA_GATEWAY_PORT=4099

# Persist MOA state (memory, gateway allowlist) on a volume.
VOLUME ["/home/moa/.moa"]

CMD ["node", "gateway/dist/index.js"]
