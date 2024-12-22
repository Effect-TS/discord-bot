import { AiInput, Completions } from "@effect/ai"
import { AiHelpers, CompletionsLive } from "bot/Ai"
import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordApplication, DiscordLive } from "bot/Discord"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"
import { Data, Effect, Layer, pipe } from "effect"

class NonEligibleMessage extends Data.TaggedError("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function* () {
  const ai = yield* AiHelpers
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const channels = yield* ChannelsCache
  const completions = yield* Completions.Completions

  const application = yield* DiscordApplication
  const botUser = application.bot!

  const generateCompletion = (
    thread: Discord.Channel,
    message: Discord.MessageCreateEvent,
  ) =>
    ai.generateAiInput(thread, message).pipe(
      Effect.flatMap(completions.create),
      AiInput.provideSystem(`You are Effect Bot, a funny, helpful assistant for the Effect Discord community.

Please keep replies under 2000 characters.

The title of this conversation is "${thread.name ?? "A thread"}".`),
      Effect.map(r => r.text),
    )

  const run = gateway.handleDispatch(
    "MESSAGE_CREATE",
    Effect.fnUntraced(
      function* (message) {
        if (message.author.bot)
          return yield* new NonEligibleMessage({ reason: "from-bot" })
        if (!message.mentions.some(_ => _.id === botUser.id))
          return yield* new NonEligibleMessage({ reason: "non-mentioned" })

        const channel = yield* channels.get(
          message.guild_id!,
          message.channel_id,
        )
        if (channel.type !== Discord.ChannelType.PUBLIC_THREAD)
          return yield* new NonEligibleMessage({ reason: "not-in-thread" })

        const content = yield* generateCompletion(channel, message)

        yield* rest.createMessage(message.channel_id, {
          message_reference: { message_id: message.id },
          content: Str.truncate(content, 2000),
        })
      },
      Effect.catchTags({
        NonEligibleMessage: _ => Effect.void,
      }),
      Effect.catchAllCause(Effect.logError),
    ),
  )

  yield* Effect.forkScoped(run)
})

export const MentionsLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordLive),
  Layer.provide(CompletionsLive),
)
