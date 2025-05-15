import { TracerLayer } from "@chat/shared/Otel"
import { SqlClientLayer } from "@chat/shared/Sql"
import { RunnerAddress } from "@effect/cluster"
import {
  NodeClusterShardManagerSocket,
  NodeRuntime
} from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"

Layer.unwrapEffect(Effect.gen(function*() {
  const env = yield* Config.string("NODE_ENV").pipe(
    Config.withDefault("development")
  )
  const isProduction = env === "production"
  const host = isProduction ? "fly-local-6pn" : "localhost"

  return NodeClusterShardManagerSocket.layer({
    storage: "sql",
    shardingConfig: {
      shardManagerAddress: RunnerAddress.make(host, 8080)
    }
  })
})).pipe(
  Layer.provide(SqlClientLayer),
  Layer.provide(TracerLayer("shard-manager")),
  Layer.launch,
  NodeRuntime.runMain
)
