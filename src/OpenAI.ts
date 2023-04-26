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
}

export class OpenAIError extends Data.TaggedClass("OpenAIError")<{
  readonly error: unknown
}> {}

const make = (params: OpenAIOptions) => {
  const config = new Configuration({
    apiKey: ConfigSecret.value(params.apiKey),
  })

  const client = new OpenAIApi(config)

  const call = <A>(f: (api: OpenAIApi, signal: AbortSignal) => Promise<A>) =>
    Effect.tryCatchPromiseInterrupt(
      signal => f(client, signal),
      error => new OpenAIError({ error }),
    )

  const generateTitle = (prompt: string) => {
    console.log(`Create a short title summarizing the following text:

${prompt}`)
    return Effect.flatMap(
      call((_, signal) =>
        _.createCompletion(
          {
            model: "text-curie-001",
            prompt: `Create a short title summarizing the following text:

${prompt}`,
            temperature: 0.5,
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
          Option.fromNullable(_.data.choices[0]?.text),
          _ => _.trim().split("\n")[0],
        ),
    )
  }

  return { client, call, generateTitle } as const
}

export interface OpenAI extends ReturnType<typeof make> {}
export const OpenAI = Tag<OpenAI>()
export const makeLayer = (config: Config.Config.Wrap<OpenAIOptions>) =>
  Layer.effect(OpenAI, Effect.map(Effect.config(Config.unwrap(config)), make))
