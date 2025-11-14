import { TracerLayer } from "@chat/shared/Otel"
import { SqlClientLayer } from "@chat/shared/Sql"
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { ConversationEntity } from "./Conversation.ts"
import { MessageLoggerEntity } from "./MessageLogger.ts"
import { MessageWorkflowLayer } from "./MessageWorkflow.ts"

const RunnerLayer = Layer.unwrapEffect(Effect.gen(function*() {
  const runnerIp = yield* Config.string("FLY_PRIVATE_IP").pipe(
    Config.withDefault("localhost")
  )
  const listenHost = runnerIp === "localhost"
    ? "localhost"
    : "fly-local-6pn"
  return NodeClusterSocket.layer({
    shardingConfig: {
      runnerAddress: Option.some(RunnerAddress.make(runnerIp, 34431)),
      runnerListenAddress: Option.some(RunnerAddress.make(listenHost, 34431))
    }
  })
}))

Layer.mergeAll(
  ConversationEntity,
  MessageLoggerEntity,
  MessageWorkflowLayer
).pipe(
  Layer.provide(ClusterWorkflowEngine.layer),
  Layer.provide(RunnerLayer),
  Layer.provide(SqlClientLayer),
  Layer.provide(TracerLayer("chat-runner")),
  Layer.launch,
  NodeRuntime.runMain
)
