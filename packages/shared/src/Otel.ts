import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Option, Redacted } from "effect"

export const TracerLayer = (serviceName: string): Layer.Layer<never> =>
  Layer.unwrapEffect(Effect.gen(function*() {
    const apiKey = yield* Config.redacted("HONEYCOM_API_KEY").pipe(
      Config.option
    )
    if (Option.isNone(apiKey)) {
      return Layer.empty
    }

    return Otlp.layer({
      baseUrl: "https://api.honeycomb.io",
      resource: {
        serviceName
      },
      headers: {
        "x-honeycomb-team": Redacted.value(apiKey.value),
        "x-honeycomb-dataset": serviceName
      }
    })
  })).pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.orDie
  )
