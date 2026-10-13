# Football Auction — single production image: the game server (Express + Socket.IO)
# also serves the built Next.js site, so one service on one domain handles everything.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies first (better layer caching). Prisma's postinstall needs the schema + config,
# and prisma.config.ts reads DATABASE_URL — a placeholder is fine at build time.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/prisma.config.ts apps/server/
COPY apps/server/prisma apps/server/prisma
COPY apps/web/package.json apps/web/
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN DATABASE_URL=$DATABASE_URL npm ci --no-audit --no-fund

# App source + data, then build the website and bundle the server.
COPY . .
RUN npm run build -w @fa/web && npm run build -w @fa/server

# Don't run as root.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production \
    STORAGE=db \
    SERVE_WEB=1 \
    DATA_DIR=../../data \
    PORT=8080
EXPOSE 8080
WORKDIR /app/apps/server

# On every start: apply migrations, seed player data on the very first boot, run the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/import.js --if-empty && exec node dist/index.js"]
