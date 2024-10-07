import type { OctokitResponse } from "@octokit/types"
import { nestedConfigProvider } from "bot/utils/Config"
import {
  Chunk,
  Config,
  Data,
  Effect,
  Option,
  Redacted,
  Stream,
  pipe,
} from "effect"
import { Octokit } from "octokit"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: unknown
}> {}

export class Github extends Effect.Service<Github>()("app/Github", {
  effect: Effect.gen(function* () {
    const token = yield* Config.redacted("token")
    const octokit = new Octokit({ auth: Redacted.value(token) })

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
  }).pipe(Effect.withConfigProvider(nestedConfigProvider("github"))),
}) {}

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullable(linkHeader),
    Option.filter(_ => _.includes(`rel=\"next\"`)),
    Option.as(page + 1),
  )
