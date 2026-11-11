FROM node:24.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-venv ffmpeg git openssh-client tini libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.152.1
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY requirements.txt ./
RUN python3 -m venv /opt/whisper \
    && /opt/whisper/bin/pip install --no-cache-dir -r requirements.txt yt-dlp
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node tools ./tools
COPY --chown=node:node test ./test
COPY --chown=node:node test-support ./test-support
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/bot.js"]
