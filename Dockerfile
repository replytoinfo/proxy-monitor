FROM node:26-slim AS builder

WORKDIR /app

RUN npm install -g corepack --force && corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:26-slim

WORKDIR /app

RUN npm install -g corepack --force && corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
