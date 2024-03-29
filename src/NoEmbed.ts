import { Schema, TreeFormatter } from "@effect/schema"
import { ChannelsCache } from "bot/ChannelsCache"
import { LayerUtils } from "bot/_common"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Context, Effect, Layer, Schedule, pipe } from "effect"

const make = ({
  topicKeyword,
  urlWhitelist,
}: {
  readonly topicKeyword: string
  readonly urlWhitelist: readonly string[]
}) =>
  Effect.gen(function* (_) {
    const gateway = yield* _(DiscordGateway)
    const rest = yield* _(DiscordREST)
    const channels = yield* _(ChannelsCache)

    const getChannel = (guildId: string, id: string) =>
      Effect.flatMap(channels.get(guildId, id), _ =>
        _.type === Discord.ChannelType.PUBLIC_THREAD
          ? channels.get(guildId, _.parent_id!)
          : Effect.succeed(_),
      )

    const EligibleChannel = Schema.struct({
      topic: Schema.string.pipe(Schema.includes(topicKeyword)),
    }).pipe(Schema.decodeUnknown)

    const EligibleMessage = Schema.struct({
      id: Schema.string,
      channel_id: Schema.string,
      flags: Schema.optional(Schema.number, { default: () => 0 }),
      content: Schema.string,
      embeds: Schema.nonEmptyArray(
        Schema.struct({
          url: Schema.string.pipe(
            Schema.filter(
              _ => urlWhitelist.some(url => _.includes(url)) === false,
              { message: () => "url is whitelisted" },
            ),
          ),
          type: Schema.string.pipe(
            Schema.filter(_ => _ !== Discord.EmbedType.GIFV, {
              message: () => "embed type is gif",
            }),
          ),
        }),
      ),
    }).pipe(
      Schema.filter(_ => _.content.includes(_.embeds[0].url), {
        message: () => "message content does not include embed url",
      }),
      Schema.decodeUnknown,
    )

    const handleMessage = (message: Discord.MessageCreateEvent) =>
      pipe(
        Effect.Do,
        Effect.bind("channel", () =>
          getChannel(message.guild_id!, message.channel_id).pipe(
            Effect.flatMap(EligibleChannel),
          ),
        ),
        Effect.bind("message", () =>
          (message.content
            ? Effect.succeed(message)
            : rest.getChannelMessage(message.channel_id, message.id).json
          ).pipe(Effect.flatMap(EligibleMessage)),
        ),
        Effect.flatMap(({ message }) =>
          rest.editMessage(message.channel_id, message.id, {
            flags: message.flags | Discord.MessageFlag.SUPPRESS_EMBEDS,
          }),
        ),
        Effect.catchTags({
          ParseError: error =>
            Effect.logDebug(TreeFormatter.formatIssue(error.error)),
        }),
        Effect.catchAllCause(Effect.logError),
      )

    yield* _(
      gateway.handleDispatch("MESSAGE_CREATE", handleMessage),
      Effect.retry(Schedule.spaced("1 seconds")),
      Effect.forkScoped,
    )

    yield* _(
      gateway.handleDispatch("MESSAGE_UPDATE", handleMessage),
      Effect.retry(Schedule.spaced("1 seconds")),
      Effect.forkScoped,
    )
  }).pipe(
    Effect.annotateLogs({
      service: "NoEmbed",
    }),
  )

export class NoEmbedConfig extends Context.Tag("app/NoEmbedConfig")<
  NoEmbedConfig,
  Parameters<typeof make>[0]
>() {
  static layer = LayerUtils.config(NoEmbedConfig)
}

export const NoEmbedLive = Layer.scopedDiscard(
  Effect.flatMap(NoEmbedConfig, make),
).pipe(Layer.provide(ChannelsCache.Live), Layer.provide(DiscordLive))
