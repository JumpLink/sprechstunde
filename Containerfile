FROM docker.io/library/node:24-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gettext && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY po ./po
COPY dev ./dev
RUN npm run build && npm run i18n:compile

FROM docker.io/library/node:24-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY profiles ./profiles
# /app belongs to root, so the metrics directory has to exist and be writable before the drop
# to `node` — otherwise the first metric cannot create it. Mount a volume here to keep them.
RUN install -d -o node -g node /app/var/metrics
USER node
ENV SPRECHSTUNDE_METRICS_DIR=/app/var/metrics
CMD ["node", "dist/agent/main.js", "start"]
