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
USER node
CMD ["node", "dist/agent/main.js", "start"]
