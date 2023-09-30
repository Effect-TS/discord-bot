import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Config, Effect, Error, Layer, pipe } from "effect"

class NotValidMessageError extends Error.Tagged("NotValidMessageError")<{
  readonly reason: "disabled" | "no-embed" | "gif" | "whitelist"
}> {}

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

    const handleMessage = (message: Discord.MessageCreateEvent) =>
      pipe(
        Effect.Do,
        Effect.bind("channel", () =>
          getChannel(message.guild_id!, message.channel_id),
        ),
        Effect.filterOrFail(
          ({ channel }) => channel.topic?.includes(topicKeyword) === true,
          () => new NotValidMessageError({ reason: "disabled" }),
        ),
        Effect.bind("message", () =>
          message.content
            ? Effect.succeed(message)
            : Effect.flatMap(
                rest.getChannelMessage(message.channel_id, message.id),
                _ => _.json,
              ),
        ),
        Effect.filterOrFail(
          ({ message }) =>
            message.embeds.length > 0 &&
            typeof message.embeds[0].url === "string" &&
            message.content.includes(message.embeds[0].url),
          () => new NotValidMessageError({ reason: "no-embed" }),
        ),
        Effect.filterOrFail(
          ({ message }) => message.embeds[0].type !== Discord.EmbedType.GIFV,
          () => new NotValidMessageError({ reason: "gif" }),
        ),
        Effect.filterOrFail(
          ({ message }) =>
            urlWhitelist.some(
              _ => message.embeds[0].url?.includes(_) === true,
            ) === false,
          () => new NotValidMessageError({ reason: "whitelist" }),
        ),
        Effect.flatMap(({ message }) =>
          rest.editMessage(message.channel_id, message.id, {
            flags: Number(message.flags) | Discord.MessageFlag.SUPPRESS_EMBEDS,
          }),
        ),
        Effect.catchTags({
          NotValidMessageError: () => Effect.unit,
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
