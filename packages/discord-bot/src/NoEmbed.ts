import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Config, Effect, Layer, Schedule, Schema } from "effect"
import { ChannelsCache } from "./ChannelsCache.ts"
import { nestedConfigProvider } from "./utils/Config.ts"

const make = Effect.gen(function*() {
  const topicKeyword = yield* Config.string("keyword").pipe(
    Config.withDefault("[noembed]")
  )
  const urlWhitelist = yield* Config.array(Config.string("urlWhitelist")).pipe(
    Config.withDefault(["effect.website"])
  )
  const urlExclude = yield* Config.array(Config.string("urlExclude")).pipe(
    Config.withDefault(["effect.website/play"])
  )
  const gateway = yield* DiscordGateway
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache

  const validUrl = (url: string) =>
    urlWhitelist.some((_) => url.includes(_)) &&
    !urlExclude.some((_) => url.includes(_))

  const getChannel = (guildId: string, id: string) =>
    Effect.flatMap(
      channels.get(guildId, id),
      (_) =>
        _.type === Discord.ChannelTypes.PUBLIC_THREAD
          ? channels.get(guildId, _.parent_id!)
          : Effect.succeed(_)
    )

  const EligibleChannel = Schema.Struct({
    topic: Schema.String.pipe(Schema.includes(topicKeyword))
  })
    .annotations({ identifier: "EligibleChannel" })
    .pipe(Schema.decodeUnknown)

  const EligibleMessage = Schema.Struct({
    id: Schema.String,
    channel_id: Schema.String,
    flags: Schema.optionalWith(Schema.Number, { default: () => 0 }),
    content: Schema.String,
    embeds: Schema.NonEmptyArray(
      Schema.Struct({
        url: Schema.String.pipe(
          Schema.filter((url) => !validUrl(url), {
            message: () => "url is whitelisted"
          })
        ),
        type: Schema.String.pipe(
          Schema.filter((_) => _ !== "gifv", {
            message: () => "embed type is gif"
          })
        )
      }).annotations({ identifier: "EligibleEmbed" })
    )
  })
    .annotations({ identifier: "EligibleMessage" })
    .pipe(
      Schema.filter((_) => _.content.includes(_.embeds[0].url), {
        message: () => "message content does not include embed url"
      }),
      Schema.decodeUnknown
    )

  const handleMessage = Effect.fnUntraced(
    function*(event: Discord.GatewayMessageCreateDispatchData) {
      yield* getChannel(event.guild_id!, event.channel_id).pipe(
        Effect.flatMap(EligibleChannel)
      )
      const message = yield* EligibleMessage(
        event.content
          ? event
          : yield* rest.getMessage(event.channel_id, event.id)
      )
      yield* rest.updateMessage(message.channel_id, message.id, {
        flags: message.flags | Discord.MessageFlags.SuppressEmbeds
      })
    },
    Effect.catchTag("ParseError", Effect.logDebug),
    Effect.withSpan("NoEmbed.handleMessage"),
    Effect.catchAllCause(Effect.logDebug)
  )

  yield* gateway
    .handleDispatch("MESSAGE_CREATE", handleMessage)
    .pipe(Effect.retry(Schedule.spaced("1 seconds")), Effect.forkScoped)

  yield* gateway
    .handleDispatch("MESSAGE_UPDATE", handleMessage)
    .pipe(Effect.retry(Schedule.spaced("1 seconds")), Effect.forkScoped)
}).pipe(
  Effect.annotateLogs({ service: "NoEmbed" }),
  Effect.withConfigProvider(nestedConfigProvider("noembed"))
)

export const NoEmbedLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordGatewayLayer)
)
