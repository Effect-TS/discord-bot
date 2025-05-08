import { RunnerAddress } from "@effect/cluster"
import { NodeClusterRunnerSocket } from "@effect/platform-node"
import { Config, Effect, Layer, Logger, LogLevel, Option } from "effect"

export const ClusterLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const shardManagerHost = yield* Config.string("SHARD_MANAGER_HOST").pipe(
      Config.option,
    )

    if (Option.isNone(shardManagerHost)) {
      return Layer.empty
    }

    return NodeClusterRunnerSocket.layer({
      clientOnly: true,
      shardingConfig: {
        shardManagerAddress: RunnerAddress.make(shardManagerHost.value, 8080),
      },
    }).pipe(Layer.provide(Logger.minimumLogLevel(LogLevel.All)))
  }),
)
