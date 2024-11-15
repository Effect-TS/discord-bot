import { AiInput, AiRole, Completions } from "@effect/ai"
import {
  OpenAiClient,
  OpenAiCompletions,
  OpenAiConfig,
} from "@effect/ai-openai"
import { NodeHttpClient } from "@effect/platform-node"
import { Chunk, Config, Effect, Layer, pipe, Schedule } from "effect"
import * as Str from "./utils/String.js"
import { Tokenizer } from "@effect/ai/Tokenizer"
import { Discord, DiscordREST } from "dfx"
import { DiscordApplication } from "./Discord.js"
import { HttpClient } from "@effect/platform"

export const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  organizationId: Config.redacted("OPENAI_ORGANIZATION").pipe(
    Config.withDefault(undefined),
  ),
  transformClient: Config.succeed(
    HttpClient.retryTransient({
      times: 3,
      schedule: Schedule.exponential(500),
    }),
  ),
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const CompletionsLive = OpenAiCompletions.layer({
  model: "gpt-4o",
}).pipe(Layer.provide(OpenAiLive))

export class AiHelpers extends Effect.Service<AiHelpers>()("app/AiHelpers", {
  effect: Effect.gen(function* () {
    const rest = yield* DiscordREST
    const completions = yield* Completions.Completions
    const tokenizer = yield* Tokenizer

    const application = yield* DiscordApplication
    const botUser = application.bot!

    const generateAiInput = (
      thread: Discord.Channel,
      message?: Discord.MessageCreateEvent,
    ) =>
      pipe(
        Effect.all(
          {
            openingMessage: rest.getChannelMessage(thread.parent_id!, thread.id)
              .json,
            messages: rest.getChannelMessages(thread.id, {
              before: message?.id,
              limit: 10,
            }).json,
          },
          { concurrency: "unbounded" },
        ),
        Effect.map(({ openingMessage, messages }) =>
          AiInput.make(
            [...(message ? [message] : []), ...messages, openingMessage]
              .reverse()
              .filter(
                msg =>
                  msg.type === Discord.MessageType.DEFAULT ||
                  msg.type === Discord.MessageType.REPLY,
              )
              .filter(msg => msg.content.trim().length > 0)
              .map(
                (msg): AiInput.Message =>
                  AiInput.Message.fromInput(
                    msg.content,
                    msg.author.id === botUser.id
                      ? AiRole.model
                      : AiRole.userWithName(msg.author.username),
                  ),
              ),
          ),
        ),
      )

    const generateTitle = (prompt: string) =>
      completions.create(prompt).pipe(
        AiInput.provideSystem(
          `You are a helpful assistant for the Effect Typescript library Discord community.

Create a short title summarizing the message. Do not include markdown in the title.`,
        ),
        Effect.provideService(OpenAiConfig.OpenAiConfig, {
          temperature: 0.25,
          max_tokens: 64,
        }),
        Effect.map(_ => cleanTitle(_.text)),
        Effect.withSpan("Ai.generateTitle", { attributes: { prompt } }),
      )

    const generateDocs = (
      title: string,
      messages: AiInput.AiInput,
      instruction = "Create a documentation article from the above chat messages. The article should be written in markdown and should contain code examples where appropiate.",
    ) =>
      pipe(
        tokenizer.truncate(
          Chunk.appendAll(messages, AiInput.make(instruction)),
          30_000,
        ),
        Effect.flatMap(completions.create),
        AiInput.provideSystem(
          `You are a helpful assistant for the Effect Typescript library Discord community.

The title of this chat is "${title}".`,
        ),
        Effect.map(_ => _.text),
      )

    const generateSummary = (title: string, messages: AiInput.AiInput) =>
      generateDocs(
        title,
        messages,
        "Summarize the above messages. Also include some key takeaways.",
      )

    return {
      generateTitle,
      generateDocs,
      generateSummary,
      generateAiInput,
    } as const
  }),
  dependencies: [CompletionsLive],
}) {}

const cleanTitle = (_: string) =>
  pipe(Str.firstParagraph(_), Str.removeQuotes, Str.removePeriod)
