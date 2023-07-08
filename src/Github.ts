import type { OctokitResponse } from "@octokit/types"
import {
  Chunk,
  Config,
  ConfigSecret,
  Effect,
  Layer,
  Option,
  Stream,
  Tag,
  pipe,
} from "bot/_common"
import { Octokit } from "octokit"

export interface GithubConfig {
  readonly token: ConfigSecret.ConfigSecret
}

export class GithubError {
  readonly _tag = "GithubError"
  constructor(readonly reason: unknown) {}
}

const make = ({ token }: GithubConfig) => {
  const octokit = new Octokit({ auth: ConfigSecret.value(token) })

  const rest = octokit.rest
  type Endpoints = typeof rest

  const request = <A>(f: (_: Endpoints) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(rest),
      catch: reason => new GithubError(reason),
    })

  const wrap =
    <A, Args extends any[]>(
      f: (_: Endpoints) => (...args: Args) => Promise<OctokitResponse<A>>,
    ) =>
    (...args: Args) =>
      Effect.map(
        Effect.tryPromise({
          try: () => f(rest)(...args),
          catch: reason => new GithubError(reason),
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
          catch: reason => new GithubError(reason),
        }),
        _ => [Chunk.fromIterable(_.data), maybeNextPage(page, _.headers.link)],
      ),
    )

  return { octokit, token, request, wrap, stream }
}

export interface Github extends ReturnType<typeof make> {}
export const Github = Tag<Github>()
export const makeLayer = (_: Config.Config.Wrap<GithubConfig>) =>
  Layer.effect(Github, Effect.map(Effect.config(Config.unwrap(_)), make))

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter(_ => _.includes(`rel=\"next\"`)),
    Option.as(page + 1),
  )
