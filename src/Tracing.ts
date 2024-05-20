import {
  Config,
  Effect,
  FiberRef,
  Layer,
  LogLevel,
  Logger,
  Secret,
} from "effect"
import * as DevTools from "@effect/experimental/DevTools"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"

export const TracingLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.secret("HONEYCOMB_API_KEY"))
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
      "X-Honeycomb-Team": Secret.value(apiKey.value),
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
