import { DiscordApplication } from "@chat/discord/DiscordRest"
import { LanguageModel, Prompt, Tokenizer } from "@effect/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Discord, DiscordREST } from "dfx"
import { Config, Effect, Layer, pipe, Schedule } from "effect"
import * as Str from "./utils/String.ts"

export const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  organizationId: Config.redacted("OPENAI_ORGANIZATION").pipe(
    Config.withDefault(undefined)
  ) as any,
  transformClient: HttpClient.retryTransient({
    times: 3,
    schedule: Schedule.exponential(500)
  })
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const ChatModel = OpenAiLanguageModel.modelWithTokenizer("gpt-4o")

export class AiHelpers extends Effect.Service<AiHelpers>()("app/AiHelpers", {
  effect: Effect.gen(function*() {
    const rest = yield* DiscordREST
    const model = yield* ChatModel

    const application = yield* DiscordApplication
    const botUser = application.bot!

    const generateAiInput = (
      thread: Discord.ThreadResponse,
      message?: Discord.MessageResponse
    ) =>
      pipe(
        Effect.all(
          {
            openingMessage: rest.getMessage(thread.parent_id!, thread.id),
            messages: rest.listMessages(thread.id, {
              before: message?.id,
              limit: 10
            })
          },
          { concurrency: "unbounded" }
        ),
        Effect.map(({ messages, openingMessage }) =>
          Prompt.make(
            [...(message ? [message] : []), ...messages, openingMessage]
              .reverse()
              .filter(
                (msg) =>
                  msg.type === Discord.MessageType.DEFAULT ||
                  msg.type === Discord.MessageType.REPLY
              )
              .filter((msg) => msg.content.trim().length > 0)
              .map(
                (msg): Prompt.Message =>
                  msg.author.id === botUser.id
                    ? Prompt.makeMessage("assistant", {
                      content: [Prompt.makePart("text", { text: msg.content })]
                    })
                    : Prompt.makeMessage("user", {
                      content: [
                        Prompt.makePart("text", {
                          text: `<@${msg.author.id}>: ${msg.content}`
                        })
                      ]
                    })
              )
          )
        )
      )

    const generateTitle = (prompt: string) =>
      LanguageModel.generateText({
        prompt: [
          {
            role: "system",
            content:
              `You are a helpful assistant for the Effect Typescript library Discord community.

Create a short title summarizing the message. Do not include markdown in the title.`
          },
          { role: "user", content: [{ type: "text", text: prompt }] }
        ]
      }).pipe(
        Effect.provide(model),
        OpenAiLanguageModel.withConfigOverride({
          temperature: 0.25
          // TODO
          // max_tokens: 64
        }),
        Effect.map((_) => cleanTitle(_.text)),
        Effect.withSpan("Ai.generateTitle", { attributes: { prompt } })
      )

    const generateDocs = Effect.fn("AiHelpers.generateDocs")(function*(
      title: string,
      messages: Prompt.Prompt,
      instruction =
        "Create a documentation article from the above chat messages. The article should be written in markdown and should contain code examples where appropiate."
    ) {
      const tokenizer = yield* Tokenizer.Tokenizer
      const prompt = yield* tokenizer.truncate(
        Prompt.merge(messages, Prompt.make(instruction)),
        30_000
      )
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.merge(
          Prompt.make([{
            role: "system",
            content:
              `You are a helpful assistant for the Effect Typescript library Discord community.

The title of this chat is "${title}".`
          }]),
          prompt
        )
      })
      return response.text
    }, Effect.provide(model))

    const generateSummary = (title: string, messages: Prompt.Prompt) =>
      generateDocs(
        title,
        messages,
        "Summarize the above messages. Also include some key takeaways."
      )

    return {
      generateTitle,
      generateDocs,
      generateSummary,
      generateAiInput
    } as const
  }),
  dependencies: [OpenAiLive]
}) {}

const cleanTitle = (_: string) =>
  pipe(Str.firstParagraph(_), Str.removeQuotes, Str.removePeriod)
