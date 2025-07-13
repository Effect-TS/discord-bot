import { OpenAiClient } from "@effect/ai-openai"
import { HttpClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Layer, Schedule } from "effect"

export const OpenAiLayer = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  organizationId: Config.redacted("OPENAI_ORGANIZATION").pipe(
    Config.withDefault(undefined)
  ) as any,
  transformClient: HttpClient.retryTransient({
    times: 3,
    schedule: Schedule.exponential(500)
  })
}).pipe(Layer.provide(NodeHttpClient.layerUndici))
