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

# Copy data files (corpus + enriched; indexes are on the Railway volume at /app/data)
COPY data/corpus.json data/enriched.json ./data/

# Startup: build indexes if missing, then start the bot
CMD ["sh", "-c", "\
  if [ ! -d /app/data/index-pair ] || [ ! -d /app/data/index-window ]; then \
    echo 'Indexes not found — building (this takes a few minutes)...' && \
    cd /app && node implementations/rag/index.js && \
    echo 'Indexes built.'; \
  fi && \
  node implementations/discord-bot/bot.js"]
