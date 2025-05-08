import { AiError } from "@effect/ai"
import { ClusterSchema, Entity } from "@effect/cluster"
import { Rpc } from "@effect/rpc"
import { PrimaryKey, Schema } from "effect"

export class DiscordThread
  extends Schema.TaggedClass<DiscordThread>()("DiscordThread", {
    threadId: Schema.String
  })
{
  get discordChannelId() {
    return this.threadId
  }
  get entityId() {
    return `${this._tag}/${this.threadId}`
  }
}

export class DiscordDM extends Schema.TaggedClass<DiscordDM>()("DiscordDM", {
  channelId: Schema.String
}) {
  get discordChannelId() {
    return this.channelId
  }
  get entityId() {
    return `${this._tag}/${this.channelId}`
  }
}

export const Address = Schema.Union(DiscordThread, DiscordDM)

export class Send extends Schema.Class<Send>("Conversation/Send")({
  address: Address,
  message: Schema.String,
  messageId: Schema.String
}) {
  [PrimaryKey.symbol]() {
    return this.messageId
  }
}

export const Conversation = Entity.make("Conversation", [
  Rpc.make("send", {
    payload: Send,
    error: AiError.AiError,
    success: Schema.String
  })
]).annotateRpcs(ClusterSchema.Persisted, true)
