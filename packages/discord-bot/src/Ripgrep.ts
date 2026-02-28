import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Result, Schema, ServiceMap, Stream } from "effect"
import { Ndjson } from "effect/unstable/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class RipgrepError extends Schema.TaggedErrorClass<RipgrepError>()(
  "RipgrepError",
  {
    cause: Schema.Defect
  }
) {}

export class RipgrepMatch extends Schema.Class<RipgrepMatch>("RipgrepMatch")({
  path: Schema.String,
  lineNumber: Schema.Number,
  line: Schema.String
}) {}

const RgJsonMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Number,
    lines: Schema.Struct({ text: Schema.String })
  })
})

const RgJsonOther = Schema.Struct({
  type: Schema.Literals(["begin", "end", "context", "summary"])
})

const RgJsonLine = Schema.Union([RgJsonMatch, RgJsonOther])

export class Ripgrep extends ServiceMap.Service<
  Ripgrep,
  {
    /** Search for content matching the given pattern, returning matches with context. */
    search(options: {
      readonly pattern: string
      readonly directory: string
      readonly glob?: string | undefined
      readonly maxPerFile?: number | undefined
    }): Stream.Stream<RipgrepMatch, RipgrepError>
  }
>()("discord-bot/Ripgrep") {
  static readonly layer = Layer.effect(
    Ripgrep,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const search = (options: {
        readonly pattern: string
        readonly directory: string
        readonly glob?: string | undefined
        readonly maxPerFile?: number | undefined
      }) => {
        const args = ["--json", "--context", "3"]
        if (options.glob !== undefined) {
          args.push("--glob", options.glob)
        }
        if (options.maxPerFile !== undefined) {
          args.push("--max-count", options.maxPerFile.toString())
        }
        args.push(options.pattern)

        return spawner
          .streamString(
            ChildProcess.make("rg", args, {
              cwd: options.directory,
              stdin: "ignore"
            }),
            { includeStderr: true }
          )
          .pipe(
            Stream.pipeThroughChannel(
              Ndjson.decodeSchemaString(RgJsonLine)({
                ignoreEmptyLines: true
              })
            ),
            Stream.filterMap((line) =>
              line.type === "match"
                ? Result.succeed(
                  new RipgrepMatch({
                    path: line.data.path.text,
                    lineNumber: line.data.line_number,
                    line: line.data.lines.text.trimEnd()
                  })
                )
                : Result.failVoid
            ),
            Stream.mapError((cause) => new RipgrepError({ cause })),
            Stream.withSpan("Ripgrep.search", {
              attributes: {
                "pattern": options.pattern,
                "directory": options.directory,
                "glob": options.glob
              }
            })
          )
      }

      return Ripgrep.of({ search })
    })
  ).pipe(Layer.provide(NodeServices.layer))
}
