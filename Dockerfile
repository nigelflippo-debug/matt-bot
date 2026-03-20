FROM node:20-slim

WORKDIR /app

# Install rag dependencies (retrieve.js + generate.js live here)
COPY implementations/rag/package.json implementations/rag/package-lock.json* ./implementations/rag/
RUN cd implementations/rag && npm ci --omit=dev

# Install discord-bot dependencies
COPY implementations/discord-bot/package.json implementations/discord-bot/package-lock.json* ./implementations/discord-bot/
RUN cd implementations/discord-bot && npm ci --omit=dev

# Copy source
COPY implementations/ ./implementations/

# Stage data files outside the volume mount path so the volume doesn't hide them.
# At startup we copy them into /app/data/ if not already present.
COPY data/corpus.enc data/enriched.enc ./data-src/

# Startup: seed data files from image, build indexes if missing, then start the bot
CMD ["sh", "-c", "\
  cp -n /app/data-src/corpus.enc /app/data/corpus.enc && \
  cp -n /app/data-src/enriched.enc /app/data/enriched.enc && \
  if [ ! -d /app/data/index-pair ] || [ ! -d /app/data/index-window ]; then \
    echo 'Indexes not found — building (this takes a few minutes)...' && \
    cd /app && node --max-old-space-size=4096 implementations/rag/index.js && \
    echo 'Indexes built.'; \
  fi && \
  node implementations/discord-bot/bot.js"]
