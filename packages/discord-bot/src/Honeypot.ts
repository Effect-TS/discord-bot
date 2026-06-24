import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { type Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Config, ConfigProvider, Effect, Layer, Schedule } from "effect"
import { ChannelsCache } from "./ChannelsCache.ts"
import { nestedConfigProvider } from "./utils/Config.ts"

const make = Effect.gen(function* () {
  const topicKeyword = yield* Config.withDefault(
    Config.string("keyword"),
    "[honeypot]",
  )

  const gateway = yield* DiscordGateway
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache

  const handleMessage = Effect.fnUntraced(
    function* (event: Discord.GatewayMessageCreateDispatchData) {
      const channel = yield* channels.get(event.guild_id!, event.channel_id)
      if (!isEligibleChannel(channel, topicKeyword)) {
        return
      }

      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* rest.banUserFromGuild(event.guild_id!, event.author.id, {
            delete_message_days: 5,
          })
          yield* rest.unbanUserFromGuild(event.guild_id!, event.author.id, {})
        }),
      ).pipe(
        Effect.withSpan("Honeypot.banUser", {
          attributes: {
            userId: event.author.id,
            username: event.author.username,
          },
        }),
      )
    },
    Effect.withSpan("Honeypot.handleMessage"),
    Effect.catchCause(Effect.logDebug),
  )

  yield* gateway
    .handleDispatch("MESSAGE_CREATE", handleMessage)
    .pipe(Effect.retry(Schedule.spaced("1 seconds")), Effect.forkScoped)
}).pipe(
  Effect.annotateLogs({ service: "Honeypot" }),
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    nestedConfigProvider("honeypot"),
  ),
)

export const HoneypotLive = Layer.effectDiscard(make).pipe(
  Layer.provide(ChannelsCache.layer),
  Layer.provide(DiscordGatewayLayer),
)

const isEligibleChannel = (
  channel: Discord.GetChannel200,
  topicKeyword: string,
) =>
  "topic" in channel &&
  typeof channel.topic === "string" &&
  channel.topic.includes(topicKeyword)
