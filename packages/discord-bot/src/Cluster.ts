import { SqlClientLayer } from "@chat/shared/Sql"
import type { Runners, Sharding } from "@effect/cluster"
import { ClusterWorkflowEngine } from "@effect/cluster"
import { NodeClusterSocket } from "@effect/platform-node"
import type { WorkflowEngine } from "@effect/workflow"
import { Layer } from "effect"

const ShardingLayer = NodeClusterSocket.layer({ clientOnly: true }).pipe(
  Layer.provide(SqlClientLayer),
  Layer.orDie
)

export const ClusterLayer: Layer.Layer<
  Sharding.Sharding | Runners.Runners | WorkflowEngine.WorkflowEngine
> = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(ShardingLayer)
)
