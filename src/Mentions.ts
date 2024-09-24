import { AiInput, AiRole, Completions } from "@effect/ai"
import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordLive } from "bot/Discord"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"
import { Effect, Data, Layer, pipe } from "effect"
import { CompletionsLive } from "./Ai.js"

class NonEligibleMessage extends Data.TaggedError("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const channels = yield* ChannelsCache
  const completions = yield* Completions.Completions

  const botUser = yield* rest.getCurrentUser().json

  const generateAiInput = (
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
            limit: 10,
          }).json,
        },
        { concurrency: "unbounded" },
      ),
      Effect.map(({ openingMessage, messages }) =>
        AiInput.make(
          [message, ...messages, openingMessage]
            .reverse()
            .filter(
              msg =>
                msg.type === Discord.MessageType.DEFAULT ||
                msg.type === Discord.MessageType.REPLY,
            )
            .filter(msg => msg.content.trim().length > 0)
            .map(
              (msg): AiInput.Message =>
                AiInput.Message.fromInput(
                  msg.content,
                  msg.author.id === botUser.id
                    ? AiRole.model
                    : AiRole.userWithName(msg.author.username),
                ),
            ),
        ),
      ),
    )

  const generateCompletion = (
    thread: Discord.Channel,
    message: Discord.MessageCreateEvent,
  ) =>
    completions.create.pipe(
      AiInput.provideEffect(generateAiInput(thread, message)),
      AiInput.provideSystem(`You are Effect Bot, a funny, helpful assistant for the Effect Discord community.

Please keep replies under 2000 characters.

The title of this conversation is "${thread.name ?? "A thread"}".`),
      Effect.map(r => r.text),
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
      Effect.flatMap(thread => generateCompletion(thread, message)),
      Effect.tap(content =>
        rest.createMessage(message.channel_id, {
          message_reference: {
            message_id: message.id,
          },
          content: Str.truncate(content, 2000),
        }),
      ),
      Effect.catchTags({
        NonEligibleMessage: _ => Effect.void,
      }),
      Effect.catchAllCause(Effect.logError),
    ),
  )

  yield* Effect.forkScoped(run)
})

export const MentionsLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Live),
  Layer.provide(DiscordLive),
  Layer.provide(CompletionsLive),
)
