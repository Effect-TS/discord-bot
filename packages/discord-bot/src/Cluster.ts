import { SqlClientLayer } from "@chat/shared/Sql"
import { RunnerAddress } from "@effect/cluster"
import { NodeClusterRunnerSocket } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"

export const ClusterLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const shardManagerHost = yield* Config.string("SHARD_MANAGER_HOST").pipe(
      Config.withDefault("localhost")
    )

    return NodeClusterRunnerSocket.layer({
      clientOnly: true,
      storage: "sql",
      shardingConfig: {
        shardManagerAddress: RunnerAddress.make(shardManagerHost, 8080)
      }
    })
  })
).pipe(
  Layer.provide(SqlClientLayer),
  Layer.orDie
)
