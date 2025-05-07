import { NodeClusterShardManagerSocket, NodeRuntime } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"

const SqlLayer = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL")
})

NodeClusterShardManagerSocket.layer({ storage: "sql" }).pipe(
  Layer.provide(SqlLayer),
  Layer.launch,
  NodeRuntime.runMain
)
