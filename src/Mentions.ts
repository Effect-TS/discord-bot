import { ChannelsCache } from "bot/ChannelsCache"
import { Message, OpenAI } from "bot/OpenAI"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"
import { DiscordLive } from "dfx/gateway"
import { Effect, Data, Layer, pipe } from "effect"

class NonEligibleMessage extends Data.TaggedError("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI)

  const botUser = yield* _(rest.getCurrentUser().json)

  const generateContext = (
    thread: Discord.Channel,
    message: Discord.MessageCreateEvent,
  ) =>
    pipe(
      Effect.all(
        {
          openingMessage: rest.getChannelMessage(thread.parent_id!, thread.id)
            .json,
          messages: rest.getChannelMessages(message.channel_id, {
            before: message.id,
            limit: 4,
          }).json,
        },
        { concurrency: "unbounded" },
      ),
      Effect.map(({ openingMessage, messages }) =>
        [message, ...messages, openingMessage]
          .reverse()
          .filter(
            msg =>
              msg.type === Discord.MessageType.DEFAULT ||
              msg.type === Discord.MessageType.REPLY,
          )
          .filter(msg => msg.content.trim().length > 0)
          .map(
            (msg): Message => ({
              content: msg.content,
              name:
                msg.author.id === botUser.id
                  ? undefined
                  : `<@${msg.author.id}>`,
              bot: msg.author.id === botUser.id,
            }),
          ),
      ),
    )

  const run = gateway.handleDispatch("MESSAGE_CREATE", message =>
    pipe(
      Effect.succeed(message),
      Effect.filterOrFail(
        message => message.author.bot !== true,
        () => new NonEligibleMessage({ reason: "from-bot" }),
      ),
      Effect.filterOrFail(
        message => message.mentions.some(_ => _.id === botUser.id),
        () => new NonEligibleMessage({ reason: "non-mentioned" }),
      ),
      Effect.zipRight(channels.get(message.guild_id!, message.channel_id)),
      Effect.filterOrFail(
        _ => _.type === Discord.ChannelType.PUBLIC_THREAD,
        () => new NonEligibleMessage({ reason: "not-in-thread" }),
      ),
      Effect.flatMap(thread =>
        pipe(
          generateContext(thread, message),
          Effect.flatMap(messages =>
            openai.generateReply(thread.name ?? "A thread", messages),
          ),
        ),
      ),
      Effect.tap(content =>
        rest.createMessage(message.channel_id, {
          message_reference: {
            message_id: message.id,
          },
          content: Str.truncate(content, 2000),
        }),
      ),
      Effect.catchTags({
        NonEligibleMessage: _ => Effect.unit,
        NoSuchElementException: _ => Effect.unit,
      }),
      Effect.catchAllCause(Effect.logError),
    ),
  )

  yield* _(run, Effect.forkScoped)
})

export const MentionsLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Live),
  Layer.provide(OpenAI.Live),
  Layer.provide(DiscordLive),
)
