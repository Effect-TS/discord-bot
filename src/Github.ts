import type { OctokitResponse } from "@octokit/types"
import { LayerUtils } from "bot/_common"
import {
  Chunk,
  ConfigSecret,
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

const make = ({ token }: { readonly token: ConfigSecret.ConfigSecret }) => {
  const octokit = new Octokit({ auth: ConfigSecret.value(token) })

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

export interface GithubConfig {
  readonly _: unique symbol
}
export const GithubConfig = Context.Tag<
  GithubConfig,
  Parameters<typeof make>[0]
>()
export const layerConfig = LayerUtils.config(GithubConfig)

export interface Github {
  readonly _: unique symbol
}
export const Github = Context.Tag<Github, ReturnType<typeof make>>()
export const layer = Layer.effect(Github, Effect.map(GithubConfig, make))

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter(_ => _.includes(`rel=\"next\"`)),
    Option.as(page + 1),
  )
