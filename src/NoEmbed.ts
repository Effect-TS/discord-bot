import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Config, Data, Effect, Layer, pipe } from "bot/_common"
import { logRESTError } from "bot/utils/Errors"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"

class NotValidMessageError extends Data.TaggedClass("NotValidMessageError")<{
  readonly reason: "disabled" | "no-embed"
}> {}

export interface NoEmbedOptions {
  readonly topicKeyword: string
}

const make = ({ topicKeyword }: NoEmbedOptions) =>
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

    const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", message =>
      pipe(
        getChannel(message.guild_id!, message.channel_id),
        Effect.filterOrFail(
          channel => channel.topic?.includes(topicKeyword) === true,
          () => new NotValidMessageError({ reason: "disabled" }),
        ),
        Effect.filterOrFail(
          () =>
            message.embeds.length > 0 &&
            !!message.embeds[0].url &&
            message.content.includes(message.embeds[0].url),
          () => new NotValidMessageError({ reason: "no-embed" }),
        ),
        Effect.zipRight(
          rest.editMessage(message.channel_id, message.id, {
            flags: Discord.MessageFlag.SUPPRESS_EMBEDS,
          }),
        ),
        Effect.catchTags({
          NotValidMessageError: () => Effect.unit(),
          DiscordRESTError: logRESTError,
        }),
        Effect.catchAllCause(Effect.logErrorCause),
      ),
    )

    yield* _(handleMessages)
  })

export const makeLayer = (config: Config.Config.Wrap<NoEmbedOptions>) =>
  Layer.provide(
    ChannelsCacheLive,
    Layer.effectDiscard(
      Effect.flatMap(Effect.config(Config.unwrap(config)), make),
    ),
  )
