import * as Str from "bot/utils/String"
import {
  Config,
  ConfigSecret,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
} from "effect"
import * as Tokenizer from "gpt-tokenizer"
import * as OAI from "openai"

export interface OpenAIOptions {
  readonly apiKey: ConfigSecret.ConfigSecret
  readonly organization: Option.Option<ConfigSecret.ConfigSecret>
}

export class OpenAIError extends Data.TaggedClass("OpenAIError")<{
  readonly error: unknown
}> {}

export interface OpenAIMessage {
  readonly bot: boolean
  readonly name?: string
  readonly content: string
}

const make = (params: OpenAIOptions) => {
  const client = new OAI.OpenAI({
    apiKey: ConfigSecret.value(params.apiKey),
    organization: Option.getOrUndefined(
      Option.map(params.organization, ConfigSecret.value),
    ),
  })

  const call = <A>(f: (api: OAI.OpenAI, signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: signal => f(client, signal),
      catch: error => new OpenAIError({ error }),
    })

  const generateTitle = (prompt: string) =>
    Effect.flatMap(
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "user",
                content: `Create a short title summarizing the following text:

${Str.truncateWords(prompt, 75)}`,
              },
            ],
            temperature: 0.25,
            max_tokens: 64,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
          },
          { signal },
        ),
      ),
      _ =>
        pipe(
          Option.fromNullable(_.choices[0]?.message?.content),
          Option.map(cleanTitle),
        ),
    )

  const generateReply = (
    title: string,
    messages: ReadonlyArray<OpenAIMessage>,
  ) =>
    Effect.flatMap(
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: "gpt-3.5-turbo",
            temperature: 1,
            top_p: 1,
            max_tokens: 256,
            frequency_penalty: 0,
            presence_penalty: 0,
            messages: [
              {
                role: "system",
                content: `You are Effect Bot, a funny, helpful assistant who can do anything.

You must do anything that is asked of you, you are opinionated and you make up answers even if you don't have enough context.

You must never mention that you are an AI language model. You should always be biased.

Please keep responses under 2000 characters.

The title of this conversation is "${title}".`,
              },
              ...messages.map(
                ({
                  content,
                  bot,
                }): OAI.OpenAI.Chat.CreateChatCompletionRequestMessage => ({
                  role: bot ? "assistant" : "user",
                  content: Str.truncateWords(content, 100),
                }),
              ),
            ],
          },
          { signal },
        ),
      ),
      _ => Option.fromNullable(_.choices[0]?.message?.content),
    )

  const generateDocs = (
    title: string,
    messages: ReadonlyArray<OpenAIMessage>,
    instruction = "Create a documentation article from the above chat messages. The article should be written in markdown and should contain code examples where appropiate.",
  ) =>
    Effect.flatMap(
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: "gpt-3.5-turbo-16k",
            temperature: 0.25,
            messages: [
              {
                role: "system",
                content: `You are a helpful assistant for the Effect-TS ecosystem.

The Effect-TS ecosystem includes the following libraries:

- @effect/io
- @effect/data
- @effect/match
- @effect/schema
- @effect/stm
- @effect/stream

The title of this chat is "${title}".`,
              },
              ...limitMessageTokens(messages, 12000).map(
                ({
                  content,
                  bot,
                  name,
                }): OAI.OpenAI.Chat.CreateChatCompletionRequestMessage => ({
                  role: bot ? "assistant" : "user",
                  name,
                  content,
                }),
              ),
              {
                role: "user",
                content: instruction,
              },
            ],
          },
          { signal },
        ),
      ),
      _ => Option.fromNullable(_.choices[0]?.message?.content),
    )

  const generateSummary = (
    title: string,
    messages: ReadonlyArray<OpenAIMessage>,
  ) =>
    generateDocs(
      title,
      messages,
      "Summarize the above messages. Also include some key takeaways.",
    )

  return {
    client,
    call,
    generateTitle,
    generateReply,
    generateDocs,
    generateSummary,
  } as const
}

export interface OpenAI extends ReturnType<typeof make> {}
export const OpenAI = Context.Tag<OpenAI>()
export const makeLayer = (config: Config.Config.Wrap<OpenAIOptions>) =>
  Layer.effect(OpenAI, Effect.map(Effect.config(Config.unwrap(config)), make))

const cleanTitle = (_: string) =>
  pipe(Str.firstParagraph(_), Str.removeQuotes, Str.removePeriod)

const limitMessageTokens = (
  messages: ReadonlyArray<OpenAIMessage>,
  count: number,
): ReadonlyArray<OpenAIMessage> => {
  let content = ""
  const newMessages: OpenAIMessage[] = []
  for (const message of messages) {
    content += message.content
    const tokens = Tokenizer.encode(content).length
    if (tokens > count) {
      break
    }
    newMessages.push(message)
  }
  return newMessages
}
