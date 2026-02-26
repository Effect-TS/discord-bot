import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Config, ConfigProvider, Effect, Layer, Option, Schedule } from "effect"
import { ChannelsCache } from "./ChannelsCache.ts"
import { nestedConfigProvider } from "./utils/Config.ts"

const make = Effect.gen(function*() {
  const topicKeyword = yield* Config.withDefault(
    Config.string("keyword"),
    () => "[noembed]"
  )
  const urlWhitelist = yield* Config.withDefault(
    Config.string("urlWhitelist"),
    () => "effect.website"
  ).pipe(Config.map(toList))
  const urlExclude = yield* Config.withDefault(
    Config.string("urlExclude"),
    () => "effect.website/play"
  ).pipe(Config.map(toList))

  const gateway = yield* DiscordGateway
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache

  const validUrl = (url: string) =>
    urlWhitelist.some((_) => url.includes(_)) &&
    !urlExclude.some((_) => url.includes(_))

  const getChannel = (guildId: string, id: string) =>
    Effect.flatMap(
      channels.get(guildId, id),
      (channel) =>
        channel.type === Discord.ChannelTypes.PUBLIC_THREAD
          ? channels.get(guildId, channel.parent_id!)
          : Effect.succeed(channel)
    )

  const handleMessage = Effect.fnUntraced(
    function*(event: Discord.GatewayMessageCreateDispatchData) {
      const channel = yield* getChannel(event.guild_id!, event.channel_id)
      if (!isEligibleChannel(channel, topicKeyword)) {
        return
      }

      const source = event.content
        ? event
        : yield* rest.getMessage(event.channel_id, event.id)
      const message = toEligibleMessage(source, validUrl)
      if (Option.isNone(message)) {
        return
      }

      yield* rest.updateMessage(message.value.channel_id, message.value.id, {
        flags: message.value.flags | Discord.MessageFlags.SuppressEmbeds
      })
    },
    Effect.withSpan("NoEmbed.handleMessage"),
    Effect.catchCause(Effect.logDebug)
  )

  yield* gateway
    .handleDispatch("MESSAGE_CREATE", handleMessage)
    .pipe(Effect.retry(Schedule.spaced("1 seconds")), Effect.forkScoped)

  yield* gateway
    .handleDispatch("MESSAGE_UPDATE", handleMessage)
    .pipe(Effect.retry(Schedule.spaced("1 seconds")), Effect.forkScoped)
}).pipe(
  Effect.annotateLogs({ service: "NoEmbed" }),
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    nestedConfigProvider("noembed")
  )
)

export const NoEmbedLive = Layer.effectDiscard(make).pipe(
  Layer.provide(ChannelsCache.layer),
  Layer.provide(DiscordGatewayLayer)
)

const toList = (value: string) =>
  value
    .split(",")
    .map((_) => _.trim())
    .filter((_) => _.length > 0)

const isEligibleChannel = (
  channel: Discord.GetChannel200,
  topicKeyword: string
) =>
  "topic" in channel &&
  typeof channel.topic === "string" &&
  channel.topic.includes(topicKeyword)

const toEligibleMessage = (
  event: Discord.MessageResponse,
  validUrl: (_: string) => boolean
) => {
  if (typeof event?.id !== "string" || typeof event?.channel_id !== "string") {
    return Option.none()
  }
  const embeds = Array.isArray(event?.embeds) ? event.embeds : []
  if (embeds.length === 0) {
    return Option.none()
  }
  const firstEmbed = embeds[0]
  if (
    typeof firstEmbed?.url !== "string" ||
    !validUrl(firstEmbed.url) ||
    firstEmbed?.type === "gifv"
  ) {
    return Option.none()
  }
  if (
    typeof event?.content !== "string" ||
    !event.content.includes(firstEmbed.url)
  ) {
    return Option.none()
  }
  return Option.some({
    id: event.id,
    channel_id: event.channel_id,
    flags: typeof event.flags === "number" ? event.flags : 0
  })
}
