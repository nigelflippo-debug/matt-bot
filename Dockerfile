FROM node:20-slim

WORKDIR /app

# Install rag dependencies (retrieve.js + generate.js live here)
COPY src/rag/package.json src/rag/package-lock.json* ./src/rag/
RUN cd src/rag && npm ci --omit=dev

# Install discord-bot dependencies
COPY src/discord-bot/package.json src/discord-bot/package-lock.json* ./src/discord-bot/
RUN cd src/discord-bot && npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Stage data files outside the volume mount path so the volume doesn't hide them.
# At startup we copy them into /app/data/ if not already present.
COPY data/corpus.enc data/enriched.enc data/lore.enc ./data-src/

# Startup: seed data files from image, build indexes if missing, then start the bot
CMD ["sh", "-c", "\
  cp -n /app/data-src/corpus.enc /app/data/corpus.enc && \
  cp -n /app/data-src/enriched.enc /app/data/enriched.enc && \
  cp -n /app/data-src/lore.enc /app/data/lore.enc && \
  node /app/src/rag/merge-lore.js && \
  if [ ! -d /app/data/index-pair ] || [ ! -d /app/data/index-window ]; then \
    echo 'Indexes not found — building (this takes a few minutes)...' && \
    cd /app && node --max-old-space-size=4096 src/rag/index.js && \
    echo 'Indexes built.'; \
  fi && \
  node src/discord-bot/bot.js"]
