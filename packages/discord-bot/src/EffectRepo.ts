import { NodeServices } from "@effect/platform-node"
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  RcRef,
  Schedule,
  Schema,
  ServiceMap,
  Stream
} from "effect"
import { glob } from "glob"
import { Git } from "./Git.ts"
import type { RipgrepMatch } from "./Ripgrep.ts"
import { Ripgrep } from "./Ripgrep.ts"

export class EffectRepoError extends Schema.TaggedErrorClass<EffectRepoError>()(
  "EffectRepoError",
  { cause: Schema.Defect }
) {}

export class EffectRepo extends ServiceMap.Service<
  EffectRepo,
  {
    /** Search for content matching the given pattern, returning matches with context. */
    search(options: {
      readonly pattern: string
      readonly glob?: string | undefined
    }): Stream.Stream<RipgrepMatch, EffectRepoError>

    /** Read a range of lines from a file in the repo. */
    readFileRange(options: {
      readonly path: string
      readonly startLine?: number | undefined
      readonly endLine?: number | undefined
    }): Effect.Effect<string, EffectRepoError>

    /** Find files matching a glob pattern in the repo. */
    glob(options: {
      readonly pattern: string
    }): Effect.Effect<Array<string>, EffectRepoError>

    readonly llmsMd: Effect.Effect<string, EffectRepoError>
  }
>()("discord-bot/EffectRepo") {
  static readonly layer = Layer.effect(
    EffectRepo,
    Effect.gen(function*() {
      const git = yield* Git
      const rg = yield* Ripgrep
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const repo = Fiber.join(
        yield* Effect.forkScoped(
          git.clone("https://github.com/effect-ts/effect-smol.git")
        )
      )

      // Pull the repo every 15 minutes to keep it up to date
      yield* Effect.gen(function*() {
        const repoPath = yield* repo
        while (true) {
          yield* Effect.sleep("15 minutes")
          yield* git.pull(repoPath)
          yield* RcRef.invalidate(llmsMd)
        }
      }).pipe(
        Effect.retry(Schedule.forever),
        Effect.forkScoped
      )

      const search = (options: {
        readonly pattern: string
        readonly glob?: string | undefined
      }) =>
        Stream.unwrap(
          Effect.map(repo, (repoPath) =>
            rg.search({
              directory: repoPath,
              pattern: options.pattern,
              glob: options.glob
            }))
        ).pipe(Stream.mapError((cause) => new EffectRepoError({ cause })))

      const readFileRange = Effect.fn("EffectRepo.readFileRange")(
        function*(options: {
          readonly path: string
          readonly startLine?: number | undefined
          readonly endLine?: number | undefined
        }) {
          const repoPath = yield* repo
          const content = yield* fs.readFileString(
            path.join(repoPath, options.path)
          )
          const lines = content.split("\n")
          const start = Math.max(0, (options.startLine ?? 1) - 1)
          const end = options.endLine ?? lines.length
          return lines.slice(start, end).join("\n")
        },
        Effect.mapError((cause) => new EffectRepoError({ cause }))
      )

      const globFiles = Effect.fn("EffectRepo.glob")(
        function*(options: { readonly pattern: string }) {
          const repoPath = yield* repo
          return yield* Effect.tryPromise(() =>
            glob(options.pattern, { cwd: repoPath })
          )
        },
        Effect.mapError((cause) => new EffectRepoError({ cause }))
      )

      const llmsMd = yield* RcRef.make({
        acquire: readFileRange({
          path: "LLMS.md"
        }),
        idleTimeToLive: Duration.infinity
      })

      return EffectRepo.of({
        search,
        readFileRange,
        glob: globFiles,
        llmsMd: Effect.scoped(RcRef.get(llmsMd))
      })
    })
  ).pipe(Layer.provide([Git.layer, Ripgrep.layer, NodeServices.layer]))
}
