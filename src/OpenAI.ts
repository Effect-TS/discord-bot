import {
  Config,
  ConfigSecret,
  Data,
  Effect,
  Layer,
  Option,
  Tag,
} from "bot/_common"
import { Configuration, OpenAIApi } from "openai"

export interface OpenAIOptions {
  readonly apiKey: ConfigSecret.ConfigSecret
  readonly organization: Option.Option<ConfigSecret.ConfigSecret>
}

export class OpenAIError extends Data.TaggedClass("OpenAIError")<{
  readonly error: unknown
}> {}

const make = (params: OpenAIOptions) => {
  const config = new Configuration({
    apiKey: ConfigSecret.value(params.apiKey),
    organization: Option.getOrUndefined(
      Option.map(params.organization, ConfigSecret.value),
    ),
  })

  const client = new OpenAIApi(config)

  const call = <A>(f: (api: OpenAIApi, signal: AbortSignal) => Promise<A>) =>
    Effect.tryCatchPromiseInterrupt(
      signal => f(client, signal),
      error => new OpenAIError({ error }),
    )

  const generateTitle = (prompt: string) =>
    Effect.flatMap(
      call((_, signal) =>
        _.createChatCompletion(
          {
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "user",
                content: `Create a short title summarizing the following text:

${prompt.split("\n")[0].trim()}`,
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
        Option.map(
          Option.fromNullable(_.data.choices[0]?.message?.content),
          _ =>
            _.trim()
              .split("\n")[0]
              .replace(/(^"|"$)/g, ""),
        ),
    )

  return { client, call, generateTitle } as const
}

export interface OpenAI extends ReturnType<typeof make> {}
export const OpenAI = Tag<OpenAI>()
export const makeLayer = (config: Config.Config.Wrap<OpenAIOptions>) =>
  Layer.effect(OpenAI, Effect.map(Effect.config(Config.unwrap(config)), make))
