import type { OctokitResponse } from "@octokit/types"
import {
  Chunk,
  Config,
  ConfigError,
  ConfigProvider,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Secret,
  Stream,
  pipe,
} from "effect"
import { Octokit } from "octokit"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: unknown
}> {}

const make = Effect.gen(function* () {
  const token = yield* Config.secret("token")
  const octokit = new Octokit({ auth: Secret.value(token) })

  const rest = octokit.rest
  type Endpoints = typeof rest

  const request = <A>(f: (_: Endpoints) => Promise<A>) =>
    Effect.withSpan(
      Effect.tryPromise({
        try: () => f(rest),
        catch: reason => new GithubError({ reason }),
      }),
      "Github.request",
    )

  const wrap =
    <A, Args extends any[]>(
      f: (_: Endpoints) => (...args: Args) => Promise<OctokitResponse<A>>,
    ) =>
    (...args: Args) =>
      Effect.map(
        Effect.tryPromise({
          try: () => f(rest)(...args),
          catch: reason => new GithubError({ reason }),
        }),
        _ => _.data,
      )

  const stream = <A>(
    f: (_: Endpoints, page: number) => Promise<OctokitResponse<A[]>>,
  ) =>
    Stream.paginateChunkEffect(0, page =>
      Effect.map(
        Effect.tryPromise({
          try: () => f(rest, page),
          catch: reason => new GithubError({ reason }),
        }),
        _ => [
          Chunk.unsafeFromArray(_.data),
          maybeNextPage(page, _.headers.link),
        ],
      ),
    )

  return { octokit, token, request, wrap, stream } as const
}).pipe(
  Effect.withConfigProvider(
    ConfigProvider.fromEnv().pipe(
      ConfigProvider.nested("github"),
      ConfigProvider.constantCase,
    ),
  ),
)

export class Github extends Context.Tag("app/Github")<
  Github,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(Github, make)
}

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter(_ => _.includes(`rel=\"next\"`)),
    Option.as(page + 1),
  )
