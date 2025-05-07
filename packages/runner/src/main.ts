import { RunnerAddress } from "@effect/cluster"
import { NodeClusterRunnerSocket, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import * as Os from "node:os"
import { SqlClientLayer } from "./Sql.js"

const interfaces = Os.networkInterfaces()

for (const [, ifaceList] of Object.entries(interfaces)) {
  if (!ifaceList) continue
  for (const iface of ifaceList) {
    console.dir(iface)
  }
}

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
