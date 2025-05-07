FROM node:alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN --mount=type=cache,id=s/fc3fb662-ea7f-461e-821e-62b5aefb7318-/pnpm/store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run --filter=runner build
RUN pnpm deploy --filter=runner --prod /prod/runner

FROM base
COPY --from=build /prod/runner /prod/runner
WORKDIR /prod/runner
EXPOSE 34431
CMD [ "node", "dist/main.cjs" ]
