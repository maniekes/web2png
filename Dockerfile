# linux/amd64 compatibility image; legacy Chrome retained intentionally (see docs).
FROM node:22-bookworm-slim@sha256:2f0e17f8955e766e776ae16d3ac47519ca3edf47c07e5c1423527926fdd5d568

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/opt/puppeteer \
    PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true \
    CONFIG_FILE=/config/device-mappings.yaml \
    CONFIG_PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Puppeteer's pinned Chrome is downloaded at build time, never at startup.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && chmod -R a+rX /opt/puppeteer
COPY web2png.js ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.CONFIG_PORT+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "web2png.js"]
