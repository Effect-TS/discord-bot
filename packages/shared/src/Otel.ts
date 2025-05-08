import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Option, Redacted } from "effect"

export const TracerLayer = (serviceName: string): Layer.Layer<never> =>
  Layer.unwrapEffect(Effect.gen(function*() {
    const apiKey = yield* Config.redacted("HONEYCOMB_API_KEY").pipe(
      Config.option
    )
    const dataset = yield* Config.string("HONEYCOMB_DATASET").pipe(
      Config.withDefault(serviceName)
    )
    if (Option.isNone(apiKey)) {
      return Layer.empty
    }

    return Otlp.layer({
      baseUrl: "https://api.honeycomb.io",
      resource: {
        serviceName: dataset
      },
      headers: {
        "x-honeycomb-team": Redacted.value(apiKey.value),
        "x-honeycomb-dataset": dataset
      }
    })
  })).pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.orDie
  )
