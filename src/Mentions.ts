import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI } from "bot/OpenAI"
import { Data, Effect, Layer, pipe } from "bot/_common"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"

class NonEligibleMessage extends Data.TaggedClass("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI)

  const botUser = yield* _(
    rest.getCurrentUser(),
    Effect.flatMap(_ => _.json),
  )

  const handle = (message: Discord.MessageCreateEvent) =>
    message.member?.nick ?? message.author.username

  const generateContext = (message: Discord.MessageCreateEvent) =>
    pipe(
      rest.getChannelMessages(message.channel_id, {
        before: message.id,
        limit: 4,
      }),
      Effect.flatMap(_ => _.json),
      Effect.map(messages =>
        [message, ...messages]
          .reverse()
          .filter(
            _ =>
              _.type === Discord.MessageType.DEFAULT ||
              _.type === Discord.MessageType.REPLY,
          )
          .filter(_ => _.content.trim().length > 0)
          .map(
            _ => `${handle(_)}:
${_.content}`,
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
      Effect.zipRight(
        Effect.tap(channels.get(message.guild_id!, message.channel_id), _ =>
          _.type === Discord.ChannelType.PUBLIC_THREAD
            ? Effect.unit()
            : Effect.fail(new NonEligibleMessage({ reason: "not-in-thread" })),
        ),
      ),
      Effect.flatMap(thread =>
        pipe(
          generateContext(message),
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
          content,
        }),
      ),
      Effect.catchTags({
        NonEligibleMessage: _ => Effect.unit(),
        NoSuchElementException: _ => Effect.unit(),
        OpenAIError: _ => Effect.logError(JSON.stringify(_, null, 2)),
      }),
      Effect.catchAllCause(Effect.logErrorCause),
    ),
  )

  yield* _(run)
})

export const MentionsLive = Layer.provide(
  ChannelsCacheLive,
  Layer.effectDiscard(make),
)
