import { DocEntry, DocsLookup, DocsLookupLive } from "bot/DocsLookup"
import { Effect, Option, pipe } from "bot/_common"
import * as Dotenv from "dotenv"

Dotenv.config()

const make = Effect.gen(function* (_) {
  const docs = yield* _(DocsLookup)

  interface TrainingPrompt {
    readonly prompt: string
    readonly completion: string
  }

  const generateTrainingPrompts = pipe(
    docs.allDocs,
    Effect.flatMap(_ =>
      Effect.forEachPar(_.forSearch, _ => promptsFromEntry(_.entry)),
    ),
    Effect.map(_ => _.flat()),
  )

  const generateTrainingJsonl = pipe(
    generateTrainingPrompts,
    Effect.map(_ => _.map(_ => JSON.stringify(_)).join("\n")),
  )

  const promptsFromEntry = (entry: DocEntry) =>
    pipe(
      entry.formattedContent,
      Effect.map((content): ReadonlyArray<TrainingPrompt> => {
        content = content.slice(0, -1)

        const examples = content.filter(_ => _.startsWith("```"))
        const signature = Option.match(
          Option.fromNullable(examples.pop()),
          () => [] as string[],
          _ => [_],
        )
        const descriptions = content
          .filter(_ => !_.startsWith("```"))
          .filter(_ => _.trim() !== "Signature")

        return examples
          .map(
            (example): TrainingPrompt => ({
              prompt: `Show me a code example for using \`${entry.title}\` from the "${entry.packageModule}" module`,
              completion: example,
            }),
          )
          .concat(
            signature.map(
              (signature): TrainingPrompt => ({
                prompt: `What is the type signature for \`${entry.title}\` from the "${entry.packageModule}" module?`,
                completion: signature,
              }),
            ),
          )
          .concat(
            descriptions.map(
              (description): TrainingPrompt => ({
                prompt: `What is the description for \`${entry.title}\` from the "${entry.packageModule}" module?`,
                completion: description.replace(/ Signature$/g, ""),
              }),
            ),
          )
      }),
    )

  const jsonl = yield* _(generateTrainingJsonl)
  process.stdout.write(jsonl)
})

pipe(
  make,
  Effect.provideLayer(DocsLookupLive),
  Effect.catchAllCause(Effect.logErrorCause),
  Effect.runFork,
)
