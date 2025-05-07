import { NodeClusterShardManagerSocket, NodeRuntime } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Layer, Redacted } from "effect"

const SqlLayer = PgClient.layer({
  database: "effect_cluster",
  username: "cluster",
  password: Redacted.make("cluster")
})

NodeClusterShardManagerSocket.layer({ storage: "sql" }).pipe(
  Layer.provide(SqlLayer),
  Layer.launch,
  NodeRuntime.runMain
)
