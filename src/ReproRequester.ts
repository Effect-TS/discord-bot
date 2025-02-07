import { AiInput, Completions, Tokenizer } from "@effect/ai"
import { AiHelpers, CompletionsLive } from "bot/Ai"
import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordApplication, DiscordLive } from "bot/Discord"
import { NotInThreadError } from "bot/Summarizer"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Effect, Layer } from "effect"

const systemInstruction = `You are Effect Bot, a helpful assistant for the Effect Discord community.

Generate a light-hearted, comedic message to the user based on the included conversation indicating that, without a minimal reproduction of the described issue, the Effect team will not be able to further investigate.

Your message should in no way be offensive to the user.`

const make = Effect.gen(function* () {
  const ai = yield* AiHelpers
  const channels = yield* ChannelsCache
  const completions = yield* Completions.Completions
  const registry = yield* InteractionsRegistry
  const tokenizer = yield* Tokenizer.Tokenizer
  const discord = yield* DiscordREST
  const application = yield* DiscordApplication
  const scope = yield* Effect.scope

  const command = Ix.global(
    {
      name: "repro",
      description:
        "Generate a message indicating that reproduction is required",
    },
    Effect.gen(function* () {
      const context = yield* Ix.Interaction
      const channel = yield* channels.get(
        context.guild_id!,
        context.channel_id!,
      )
      if (channel.type !== Discord.ChannelType.PUBLIC_THREAD) {
        return yield* new NotInThreadError()
      }
      yield* respond(channel, context).pipe(Effect.forkIn(scope))
      return Ix.response({
        type: Discord.InteractionCallbackType
          .DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      })
    }).pipe(
      Effect.annotateLogs("command", "repro"),
      Effect.withSpan("ReproRequester.command"),
    ),
  )

  const respond = Effect.fn("ReproRequester.respond")(function* (
    channel: Discord.Channel,
    context: Discord.Interaction,
  ) {
    yield* Effect.annotateCurrentSpan({ channel: channel.id })
    const input = yield* ai.generateAiInput(channel)
    const content = yield* tokenizer.truncate(input, 30_000).pipe(
      Effect.flatMap(completions.create),
      Effect.map(response => response.text),
      AiInput.provideSystem(systemInstruction),
      Effect.annotateLogs({
        thread: channel.id,
      }),
    )
    yield* discord.editOriginalInteractionResponse(
      application.id,
      context.token,
      { content },
    )
  })

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

export const ReproRequesterLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(CompletionsLive),
  Layer.provide(DiscordLive),
)
