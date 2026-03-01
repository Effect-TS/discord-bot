import type { Api } from "@octokit/plugin-rest-endpoint-methods"
import type { OctokitResponse } from "@octokit/types"
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  Redacted,
  ServiceMap,
  Stream,
} from "effect"
import { Octokit } from "octokit"
import { nestedConfigProvider } from "./utils/Config.ts"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly cause: unknown
}> {}

export type GithubApi = Api["rest"]
export type GithubResponse<A> = OctokitResponse<A>

export interface GithubService {
  readonly token: Redacted.Redacted
  readonly request: <A>(
    f: (_: GithubApi) => Promise<A>,
  ) => Effect.Effect<A, GithubError, never>
  readonly wrap: <A, Args extends Array<unknown>>(
    f: (_: GithubApi) => (...args: Args) => Promise<GithubResponse<A>>,
  ) => (...args: Args) => Effect.Effect<A, GithubError, never>
  readonly stream: <A>(
    f: (_: GithubApi, page: number) => Promise<GithubResponse<Array<A>>>,
  ) => Stream.Stream<A, GithubError, never>
}

export class Github extends ServiceMap.Service<Github, GithubService>()(
  "app/Github",
  {
    make: Effect.gen(function* () {
      const token = yield* Config.redacted("token")
      const octokit = new Octokit({ auth: Redacted.value(token) })

      const rest = octokit.rest

      const request = <A>(f: (_: GithubApi) => Promise<A>) =>
        Effect.withSpan(
          Effect.tryPromise({
            try: () => f(rest),
            catch: (cause) => new GithubError({ cause }),
          }),
          "Github.request",
        )

      const wrap =
        <A, Args extends Array<any>>(
          f: (_: Api["rest"]) => (...args: Args) => Promise<OctokitResponse<A>>,
        ) =>
        (...args: Args) =>
          Effect.map(
            Effect.tryPromise({
              try: () => f(rest)(...args),
              catch: (cause) => new GithubError({ cause }),
            }),
            (_) => _.data,
          )

      const stream = <A>(
        f: (_: Api["rest"], page: number) => Promise<OctokitResponse<Array<A>>>,
      ) =>
        Stream.paginate(0, (page) =>
          Effect.map(
            Effect.tryPromise({
              try: () => f(rest, page),
              catch: (cause) => new GithubError({ cause }),
            }),
            (_) => [_.data, maybeNextPage(page, _.headers.link)] as const,
          ),
        )

      return { token, request, wrap, stream } as const
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        nestedConfigProvider("github"),
      ),
    ),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}

// == helpers

const maybeNextPage = (page: number, linkHeader?: string) =>
  pipe(
    Option.fromNullishOr(linkHeader),
    Option.filter((_) => _.includes(`rel="next"`)),
    Option.as(page + 1),
  )
