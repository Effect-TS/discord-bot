import { Effect, Layer, String } from "effect"
import { AiInput, Completions, Tokenizer } from "@effect/ai"
import { Discord, Ix } from "dfx"
import { ChannelsCache } from "bot/ChannelsCache"
import { NotInThreadError } from "bot/Summarizer"
import { Messages } from "./Messages.js"
import { InteractionsRegistry } from "dfx/gateway"
import { AiHelpers, CompletionsLive } from "bot/Ai"
import { DiscordLive } from "bot/Discord"

const make = Effect.gen(function*() {
  const ai = yield* AiHelpers
  const channels = yield* ChannelsCache
  const completions = yield* Completions.Completions
  const registry = yield* InteractionsRegistry
  const tokenizer = yield* Tokenizer.Tokenizer

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
      const input = yield* ai.generateAiInput(channel, context.message!)
      const content = yield* tokenizer.truncate(input, 30_000).pipe(
        Effect.flatMap(completions.create),
        Effect.map(response => response.text),
        AiInput.provideSystem(String.stripMargin(
          `|You are Effect Bot, a funny, helpful assistant for the Effect 
           |Discord community.
           |
           |Generate a light-hearted, comedic message to the user based on the 
           |included conversation indicating that, without a minimal reproduction 
           |of the described issue, the Effect team will not be able to further 
           |investigate.
           |
           |Your message should in no way be offensive to the user.
           |
           |Please keep replies under 2000 characters.
           |
           |The title of this conversation is "${context.message?.thread?.name ?? "A thread"}".`
        )),
        Effect.annotateLogs({
          thread: channel.id
        })
      )
      return Ix.response({
        type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content }
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
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(CompletionsLive),
  Layer.provide(DiscordLive)
)
