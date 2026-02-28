import { NodeServices } from "@effect/platform-node"
import type { Scope } from "effect"
import { Effect, FileSystem, Layer, Schema, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  cause: Schema.Defect
}) {}

export class Git extends ServiceMap.Service<Git, {
  /** Clone a repository into a scoped temporary directory. */
  clone(url: string): Effect.Effect<string, GitError, Scope.Scope>
  /** Pull the latest changes in the given repository directory. */
  pull(directory: string): Effect.Effect<void, GitError>
}>()("discord-bot/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem

      const clone = Effect.fn("Git.clone")(
        function*(url: string) {
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "discord-bot-git-"
          })
          yield* spawner.string(
            ChildProcess.make("git", ["clone", url, directory])
          )
          return directory
        },
        Effect.mapError((cause) => new GitError({ cause }))
      )

      const pull = Effect.fn("Git.pull")(
        function*(directory: string) {
          yield* spawner.string(
            ChildProcess.make("git", ["pull"], { cwd: directory })
          )
        },
        Effect.mapError((cause) => new GitError({ cause }))
      )

      return Git.of({ clone, pull })
    })
  ).pipe(Layer.provide(NodeServices.layer))
}
