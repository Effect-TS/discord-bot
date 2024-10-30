import { AiInput, AiRole, Completions } from "@effect/ai"
import { AiHelpers, CompletionsLive } from "bot/Ai"
import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordLive } from "bot/Discord"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"
import { Data, Effect, Layer, pipe } from "effect"

class NonEligibleMessage extends Data.TaggedError("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> { }

const make = Effect.gen(function*() {
  const ai = yield* AiHelpers
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const channels = yield* ChannelsCache
  const completions = yield* Completions.Completions

  const botUser = yield* rest.getCurrentUser().json

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
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordLive),
  Layer.provide(CompletionsLive),
)
