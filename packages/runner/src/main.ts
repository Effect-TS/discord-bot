import { TracerLayer } from "@chat/shared/Otel"
import { SqlClientLayer } from "@chat/shared/Sql"
import { RunnerAddress } from "@effect/cluster"
import { NodeClusterRunnerSocket, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { ConversationEntity } from "./Conversation.ts"
import { MessageLoggerEntity } from "./MessageLogger.ts"

const RunnerLayer = Layer.unwrapEffect(Effect.gen(function*() {
  const runnerIp = yield* Config.string("FLY_PRIVATE_IP").pipe(
    Config.withDefault("localhost")
  )
  const shardManagerHost = runnerIp === "localhost"
    ? "localhost"
    : "shard-manager.internal"
  const listenHost = runnerIp === "localhost"
    ? "localhost"
    : "fly-local-6pn"
  return NodeClusterRunnerSocket.layer({
    storage: "sql",
    shardingConfig: {
      runnerAddress: Option.some(RunnerAddress.make(runnerIp, 34431)),
      runnerListenAddress: Option.some(RunnerAddress.make(listenHost, 34431)),
      shardManagerAddress: RunnerAddress.make(shardManagerHost, 8080)
    }
  })
}))

Layer.mergeAll(
  ConversationEntity,
  MessageLoggerEntity
).pipe(
  Layer.provide(RunnerLayer),
  Layer.provide(SqlClientLayer),
  Layer.provide(TracerLayer("chat-runner")),
  Layer.launch,
  NodeRuntime.runMain
)
