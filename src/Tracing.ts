import * as DevTools from "@effect/experimental/DevTools"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
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

    return NodeSdk.layer(() => ({
      resource: {
        serviceName: dataset,
      },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: "https://api.honeycomb.io/v1/traces",
          headers,
        }),
      ),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: "https://api.honeycomb.io/v1/metrics",
          headers,
        }),
        exportIntervalMillis: 5000,
      }),
    }))
  }),
)
