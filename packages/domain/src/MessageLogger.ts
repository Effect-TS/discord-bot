import { ClusterSchema, Entity } from "@effect/cluster"
import { Rpc } from "@effect/rpc"
import { PrimaryKey, Schema } from "effect"

export class Log extends Schema.Class<Log>("MessageLogger/log")({
  id: Schema.String,
  author: Schema.String,
  message: Schema.String
}) {
  [PrimaryKey.symbol]() {
    return this.id
  }
}

export const MessageLogger = Entity.make("MessageLogger", [
  Rpc.make("log", { payload: Log })
]).annotateRpcs(ClusterSchema.Persisted, true)
