import { OpenAiCompletions, OpenAiClient } from "@effect/ai-openai"
import { Chunk, Config, Context, Effect, Layer, pipe } from "effect"
import { AiInput, Completions } from "@effect/ai"
import * as Str from "./utils/String.js"
import { NodeHttpClient } from "@effect/platform-node"

export const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  organizationId: Config.redacted("OPENAI_ORGANIZATION").pipe(
    Config.withDefault(undefined),
  ),
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const CompletionsLive = OpenAiCompletions.layer({
  model: "gpt-4o",
}).pipe(Layer.provide(OpenAiLive))

const make = Effect.gen(function* () {
  const completions = yield* Completions.Completions

  const generateTitle = (prompt: string) =>
    completions.create.pipe(
      AiInput.provideSystem("Create a short title summarizing the message."),
      AiInput.provide(Str.truncateWords(prompt, 500)),
      Effect.provideService(OpenAiCompletions.OpenAiConfig, {
        temperature: 0.25,
        max_tokens: 64,
      }),
      Effect.map(_ => cleanTitle(_.text)),
      Effect.withSpan("Ai.generateTitle", { attributes: { prompt } }),
    )

  const generateDocs = (
    title: string,
    messages: AiInput.AiInput.Type,
    instruction = "Create a documentation article from the above chat messages. The article should be written in markdown and should contain code examples where appropiate.",
  ) =>
    completions.create.pipe(
      Effect.provideService(
        AiInput.SystemInstruction,
        `You are a helpful assistant for the Effect-TS ecosystem.

The title of this chat is "${title}".`,
      ),
      AiInput.provideEffect(
        Chunk.appendAll(messages, AiInput.make(instruction)).pipe(
          AiInput.truncate(30_000),
          Effect.provideService(Completions.Completions, completions),
        ),
      ),
      Effect.map(_ => _.text),
    )

  const generateSummary = (title: string, messages: AiInput.AiInput.Type) =>
    generateDocs(
      title,
      messages,
      "Summarize the above messages. Also include some key takeaways.",
    )

  return {
    generateTitle,
    generateDocs,
    generateSummary,
  } as const
})

export class AiHelpers extends Context.Tag("app/AiHelpers")<
  AiHelpers,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(AiHelpers, make).pipe(
    Layer.provide(CompletionsLive),
  )
}

const cleanTitle = (_: string) =>
  pipe(Str.firstParagraph(_), Str.removeQuotes, Str.removePeriod)
