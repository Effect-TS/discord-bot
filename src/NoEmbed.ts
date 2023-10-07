import { Schema, TreeFormatter } from "@effect/schema"
import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Config, Effect, Data, Layer, pipe } from "effect"

export interface NoEmbedOptions {
  readonly topicKeyword: string
  readonly urlWhitelist: readonly string[]
}

const make = ({ topicKeyword, urlWhitelist }: NoEmbedOptions) =>
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
    }).pipe(Schema.parse)

    const EligibleMessage = Schema.struct({
      id: Schema.string,
      channel_id: Schema.string,
      flags: Schema.optional(Schema.number).withDefault(() => 0),
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
      Schema.parse,
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
            : Effect.flatMap(
                rest.getChannelMessage(message.channel_id, message.id),
                _ => _.json,
              )
          ).pipe(Effect.flatMap(EligibleMessage)),
        ),
        Effect.flatMap(({ message }) =>
          rest.editMessage(message.channel_id, message.id, {
            flags: message.flags | Discord.MessageFlag.SUPPRESS_EMBEDS,
          }),
        ),
        Effect.catchTags({
          ParseError: error =>
            Effect.logDebug(TreeFormatter.formatErrors(error.errors)),
        }),
        Effect.catchAllCause(Effect.logError),
      )

    yield* _(
      Effect.all(
        [
          gateway.handleDispatch("MESSAGE_CREATE", handleMessage),
          gateway.handleDispatch("MESSAGE_UPDATE", handleMessage),
        ],
        { concurrency: "unbounded" },
      ),
    )
  })

export const makeLayer = (config: Config.Config.Wrap<NoEmbedOptions>) =>
  Layer.provide(
    ChannelsCacheLive,
    Layer.effectDiscard(
      Effect.flatMap(Effect.config(Config.unwrap(config)), make),
    ),
  )
