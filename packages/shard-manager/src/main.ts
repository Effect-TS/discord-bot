import { TracerLayer } from "@chat/shared/Otel"
import { SqlClientLayer } from "@chat/shared/Sql"
import { RunnerAddress } from "@effect/cluster"
import { NodeClusterShardManagerSocket, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

NodeClusterShardManagerSocket.layer({
  storage: "sql",
  shardingConfig: {
    shardManagerAddress: RunnerAddress.make("fly-local-6pn", 8080)
  }
}).pipe(
  Layer.provide(SqlClientLayer),
  Layer.provide(TracerLayer("shard-manager")),
  Layer.launch,
  NodeRuntime.runMain
)
