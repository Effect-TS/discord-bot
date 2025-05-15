import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { MessageLogger } from "@chat/domain/MessageLogger"
import { DiscordGateway } from "dfx/DiscordGateway"
import { Effect, Layer } from "effect"
import { ChannelsCache } from "./ChannelsCache.ts"
import { ClusterLayer } from "./Cluster.ts"

const make = Effect.gen(function*() {
  const gateway = yield* DiscordGateway
  const channels = yield* ChannelsCache
  const makeLogger = yield* MessageLogger.client

  const run = gateway.handleDispatch(
    "MESSAGE_CREATE",
    Effect.fnUntraced(
      function*(message) {
        if (message.author.bot) {
          return
        }

        const channel = yield* channels.get(
          message.guild_id!,
          message.channel_id
        )

        const logger = makeLogger(channel.id)
        yield* logger.log({
          id: message.id,
          author: message.author.username,
          message: message.content
        })
      },
      (effect, message) =>
        Effect.withSpan(effect, "MessageLogger.handle", {
          attributes: { messageId: message.id }
        }),
      Effect.catchAllCause(Effect.logError)
    )
  )

  yield* Effect.forkScoped(run)
})

export const MessageLoggerLayer = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordGatewayLayer),
  Layer.provide(ClusterLayer)
)
