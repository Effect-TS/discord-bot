import { RunnerAddress } from "@effect/cluster"
import { NodeClusterRunnerSocket, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { SqlClientLayer } from "./Sql.js"

console.dir(process.env)

const RunnerLayer = Layer.unwrapEffect(Effect.gen(function*() {
  return NodeClusterRunnerSocket.layer({
    storage: "sql",
    shardingConfig: {
      runnerAddress: Option.some(RunnerAddress.make("::", 34431))
    }
  })
}))

Layer.empty.pipe(
  Layer.provide(RunnerLayer),
  Layer.provide(SqlClientLayer),
  Layer.launch,
  NodeRuntime.runMain
)
