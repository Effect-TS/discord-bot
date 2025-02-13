FROM node:22-alpine AS deps
WORKDIR /app
ENV COREPACK_INTEGRITY_KEYS=0
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
ENV COREPACK_INTEGRITY_KEYS=0
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN corepack pnpm build 
RUN corepack pnpm prune --prod


FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

CMD ["node", "dist/main.cjs"]
