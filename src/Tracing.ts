import * as DevTools from "@effect/experimental/DevTools"
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, FiberRef, Layer, LogLevel, Redacted } from "effect"

export const TracingLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.redacted("HONEYCOMB_API_KEY"))
    const dataset = yield* Config.withDefault(
      Config.string("HONEYCOMB_DATASET"),
      "discord-bot",
    )
    if (apiKey._tag === "None") {
      return DevTools.layer().pipe(
        Layer.locally(FiberRef.currentMinimumLogLevel, LogLevel.None),
      )
    }

    const headers = {
      "X-Honeycomb-Team": Redacted.value(apiKey.value),
      "X-Honeycomb-Dataset": dataset,
    }

    return Otlp.layer({
      baseUrl: "https://api.honeycomb.io",
      resource: {
        serviceName: dataset,
      },
      headers,
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  }),
)
