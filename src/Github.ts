import type { OctokitResponse } from "@octokit/types"
import { LayerUtils } from "bot/_common"
import {
  Chunk,
  Secret,
  Context,
  Effect,
  Data,
  Layer,
  Option,
  Stream,
  pipe,
} from "effect"
import { Octokit } from "octokit"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: unknown
}> {}

const make = ({ token }: { readonly token: Secret.Secret }) => {
  const octokit = new Octokit({ auth: Secret.value(token) })

  const rest = octokit.rest
  type Endpoints = typeof rest

  const request = <A>(f: (_: Endpoints) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(rest),
      catch: reason => new GithubError({ reason }),
    })

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
}

export class GithubConfig extends Context.Tag("app/GithubConfig")<
  GithubConfig,
  Parameters<typeof make>[0]
>() {
  static layer = LayerUtils.config(this)
}

export class Github extends Context.Tag("app/Github")<
  Github,
  ReturnType<typeof make>
>() {
  static Live = GithubConfig.pipe(Effect.map(make), Layer.effect(this))
}

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter(_ => _.includes(`rel=\"next\"`)),
    Option.as(page + 1),
  )
