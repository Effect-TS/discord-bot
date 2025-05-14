import type { Api } from "@octokit/plugin-rest-endpoint-methods"
import type { OctokitResponse } from "@octokit/types"
import {
  Chunk,
  Config,
  Data,
  Effect,
  Option,
  pipe,
  Redacted,
  Stream
} from "effect"
import { Octokit } from "octokit"
import { nestedConfigProvider } from "./utils/Config.ts"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: unknown
}> {}

export class Github extends Effect.Service<Github>()("app/Github", {
  effect: Effect.gen(function*() {
    const token = yield* Config.redacted("token")
    const octokit = new Octokit({ auth: Redacted.value(token) })

    const rest = octokit.rest

    const request = <A>(f: (_: Api["rest"]) => Promise<A>) =>
      Effect.withSpan(
        Effect.tryPromise({
          try: () => f(rest as any),
          catch: (reason) => new GithubError({ reason })
        }),
        "Github.request"
      )

    const wrap = <A, Args extends Array<any>>(
      f: (_: Api["rest"]) => (...args: Args) => Promise<OctokitResponse<A>>
    ) =>
    (...args: Args) =>
      Effect.map(
        Effect.tryPromise({
          try: () => f(rest as any)(...args),
          catch: (reason) => new GithubError({ reason })
        }),
        (_) => _.data
      )

    const stream = <A>(
      f: (_: Api["rest"], page: number) => Promise<OctokitResponse<Array<A>>>
    ) =>
      Stream.paginateChunkEffect(0, (page) =>
        Effect.map(
          Effect.tryPromise({
            try: () => f(rest as any, page),
            catch: (reason) => new GithubError({ reason })
          }),
          (_) => [
            Chunk.unsafeFromArray(_.data),
            maybeNextPage(page, _.headers.link)
          ]
        ))

    return { token, request, wrap, stream } as const
  }).pipe(Effect.withConfigProvider(nestedConfigProvider("github")))
}) {}

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter((_) => _.includes(`rel="next"`)),
    Option.as(page + 1)
  )
