import { Chunk, Effect, Layer, Stream } from "effect"
import { AiInput, AiRole } from "@effect/ai"
import { Discord, Ix } from "dfx"
import { ChannelsCache } from "bot/ChannelsCache"
import { NotInThreadError } from "bot/Summarizer"
import { Messages } from "./Messages.js"
import { InteractionsRegistry } from "dfx/gateway"
import { AiHelpers } from "bot/Ai"
import { DiscordLive } from "bot/Discord"

const make = Effect.gen(function*() {
  const ai = yield* AiHelpers
  const channels = yield* ChannelsCache
  const messages = yield* Messages
  const registry = yield* InteractionsRegistry

  const createReproRequest = (channel: Discord.Channel) =>
    messages.cleanForChannel(channel).pipe(
      Stream.runCollect,
      Effect.map(chunk =>
        Chunk.map(
          Chunk.reverse(chunk),
          (msg): AiInput.Message =>
            AiInput.Message.fromInput(
              msg.content,
              AiRole.userWithName(msg.author.username),
            ),
        ),
      ),
      Effect.flatMap((messages) => ai.generateReproRequest(messages))
    )

  const command = Ix.global(
    {
      name: "repro",
      description: "Generate a message indicating that reproduction is required"
    },
    Effect.gen(function*() {
      const context = yield* Ix.Interaction
      const channel = yield* channels.get(
        context.guild_id!,
        context.channel_id!,
      )
      if (channel.type !== Discord.ChannelType.PUBLIC_THREAD) {
        return yield* new NotInThreadError()
      }
      const message = yield* createReproRequest(channel).pipe(
        Effect.annotateLogs({
          thread: channel.id
        }),
      )
      return Ix.response({
        type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: message }
      })
    }).pipe(
      Effect.annotateLogs("command", "repro"),
      Effect.withSpan("ReproRequester.command"),
    ),
  )

  const ix = Ix.builder
    .add(command)
    .catchTagRespond("NotInThreadError", () =>
      Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "This command can only be used in a thread",
            flags: Discord.MessageFlag.EPHEMERAL,
          },
        }),
      ),
    )
    .catchAllCause(Effect.logError)

  yield* registry.register(ix)
})

export const ReproRequesterLive = Layer.effectDiscard(make).pipe(
  Layer.provide(DiscordLive),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(Messages.Default),
  Layer.provide(AiHelpers.Default),
)
