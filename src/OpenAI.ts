import { LayerUtils } from "bot/_common"
import * as Str from "bot/utils/String"
import {
  Secret,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  Predicate,
  Metric,
} from "effect"
import * as Tokenizer from "gpt-tokenizer"
import * as OAI from "openai"
import type { APIError } from "openai/error.mjs"

const metrics = {
  duration: Metric.timer("openai_duration"),
  calls: Metric.counter("openai_calls", {
    bigint: true,
    incremental: true,
  }),
} as const

export class OpenAIError extends Data.TaggedError("OpenAIError")<{
  readonly error: APIError
}> {
  get message() {
    return String(
      Predicate.hasProperty(this.error, "message")
        ? this.error.message
        : this.error,
    )
  }
}

export interface Message {
  readonly bot: boolean
  readonly name?: string
  readonly content: string
}

const make = (params: {
  readonly apiKey: Secret.Secret
  readonly organization: Option.Option<Secret.Secret>
}) => {
  const client = new OAI.OpenAI({
    apiKey: Secret.value(params.apiKey),
    organization: Option.getOrUndefined(
      Option.map(params.organization, Secret.value),
    ),
  })

  const call = <A>(f: (api: OAI.OpenAI, signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: signal => f(client, signal),
      catch: error => new OpenAIError({ error: error as APIError }),
    }).pipe(
      Metric.trackDuration(metrics.duration),
      Metric.trackAll(metrics.calls, 1n),
      Effect.withSpan("OpenAI.call"),
    )

  const generateTitle = (prompt: string) =>
    call((_, signal) =>
      _.chat.completions.create(
        {
          model: "gpt-4-turbo-preview",
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
    ).pipe(
      Effect.flatMap(_ =>
        pipe(
          Option.fromNullable(_.choices[0]?.message?.content),
          Option.map(cleanTitle),
        ),
      ),
      Effect.withSpan("OpenAI.generateTitle"),
    )

  const generateReply = (title: string, messages: ReadonlyArray<Message>) =>
    Effect.flatMap(
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: "gpt-4-turbo-preview",
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
                }): OAI.OpenAI.Chat.ChatCompletionMessageParam => ({
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
    messages: ReadonlyArray<Message>,
    instruction = "Create a documentation article from the above chat messages. The article should be written in markdown and should contain code examples where appropiate.",
  ) =>
    Effect.flatMap(
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: "gpt-4-turbo-preview",
            temperature: 0.25,
            messages: [
              {
                role: "system",
                content: `You are a helpful assistant for the Effect-TS ecosystem.

The title of this chat is "${title}".`,
              },
              ...limitMessageTokens(messages, 12000).map(
                ({
                  content,
                  bot,
                  name,
                }): OAI.OpenAI.Chat.ChatCompletionMessageParam => ({
                  role: bot ? "assistant" : "user",
                  name: name ? safeName(name) : undefined,
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

  const generateSummary = (title: string, messages: ReadonlyArray<Message>) =>
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

export class OpenAIConfig extends Context.Tag("app/OpenAIConfig")<
  OpenAIConfig,
  Parameters<typeof make>[0]
>() {
  static layer = LayerUtils.config(this)
}

export class OpenAI extends Context.Tag("app/OpenAI")<
  OpenAI,
  ReturnType<typeof make>
>() {
  static Live = Layer.effect(OpenAI, Effect.map(OpenAIConfig, make))
}

const cleanTitle = (_: string) =>
  pipe(Str.firstParagraph(_), Str.removeQuotes, Str.removePeriod)

const limitMessageTokens = (
  messages: ReadonlyArray<Message>,
  count: number,
): ReadonlyArray<Message> => {
  let content = ""
  const newMessages: Message[] = []
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

const safeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9\-_]/g, "_").replace(/_+/g, "_")
