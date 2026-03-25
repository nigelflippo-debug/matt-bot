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

# Copy persona configs
COPY personas/ ./personas/

# Stage data files outside the volume mount path so the volume doesn't hide them.
# At startup we copy them into /app/data/ if not already present.
COPY data/corpus.enc ./data-src/corpus.enc
COPY data/personas/ ./data-src/personas/

# Startup: seed data files from image, build indexes if missing, then start the bot.
# PERSONA env var selects which persona to load (default: matt).
CMD ["sh", "-c", "\
  P=${PERSONA:-matt} && \
  mkdir -p /app/data/personas/$P && \
  cp -n /app/data-src/corpus.enc /app/data/corpus.enc && \
  cp -n /app/data-src/personas/$P/enriched.enc /app/data/personas/$P/enriched.enc 2>/dev/null; \
  cp -n /app/data-src/personas/$P/lore.enc /app/data/personas/$P/lore.enc 2>/dev/null; \
  node /app/src/rag/merge-lore.js && \
  if [ ! -d /app/data/personas/$P/index-pair ] || [ ! -d /app/data/personas/$P/index-window ]; then \
    echo \"Indexes not found for $P — building (this takes a few minutes)...\" && \
    cd /app && node --max-old-space-size=4096 src/rag/index.js && \
    echo 'Indexes built.'; \
  fi && \
  node src/discord-bot/bot.js"]
