FROM node:alpine AS base
ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN --mount=type=cache,id=/pnpm/store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run --filter=shard-manager build
RUN pnpm deploy --filter=shard-manager --prod /prod/shard-manager

FROM base
COPY --from=build /prod/shard-manager /prod/shard-manager
WORKDIR /prod/shard-manager
EXPOSE 8080
CMD [ "node", "dist/main.cjs" ]
