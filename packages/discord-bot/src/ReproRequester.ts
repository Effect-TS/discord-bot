import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { DiscordApplication } from "@chat/discord/DiscordRest"
import { LanguageModel, Prompt, Tokenizer } from "@effect/ai"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Effect, Layer } from "effect"
import { AiHelpers, ChatModel, OpenAiLive } from "./Ai.ts"
import { ChannelsCache } from "./ChannelsCache.ts"
import { NotInThreadError } from "./Summarizer.ts"

const systemInstruction =
  `You are Effect Bot, a helpful assistant for the Effect Discord community.

Generate a light-hearted, comedic message to the user based on the included conversation indicating that, without a minimal reproduction of the described issue, the Effect team will not be able to further investigate.

Your message should in no way be offensive to the user.`

const make = Effect.gen(function*() {
  const ai = yield* AiHelpers
  const channels = yield* ChannelsCache
  const model = yield* ChatModel
  const registry = yield* InteractionsRegistry
  const discord = yield* DiscordREST
  const application = yield* DiscordApplication
  const scope = yield* Effect.scope

  const command = Ix.global(
    {
      name: "repro",
      description: "Generate a message indicating that reproduction is required"
    },
    Effect.fn("ReproRequester.command")(
      function*(ix) {
        const context = ix.interaction
        const channel = yield* channels.get(
          context.guild_id!,
          context.channel!.id
        )
        if (channel.type !== Discord.ChannelTypes.PUBLIC_THREAD) {
          return yield* new NotInThreadError()
        }
        yield* respond(channel, context).pipe(Effect.forkIn(scope))
        return Ix.response({
          type: Discord.InteractionCallbackTypes
            .DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        })
      },
      Effect.annotateLogs("command", "repro")
    )
  )

  const respond = Effect.fn("ReproRequester.respond")(
    function*(
      channel: Discord.ThreadResponse,
      context: Discord.APIInteraction
    ) {
      yield* Effect.annotateCurrentSpan({ channel: channel.id })
      const tokenizer = yield* Tokenizer.Tokenizer
      const input = yield* ai.generateAiInput(channel)
      const prompt = yield* tokenizer.truncate(input, 30_000)
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.merge(
          Prompt.make([{
            role: "system",
            content: systemInstruction
          }]),
          prompt
        )
      }).pipe(Effect.annotateLogs({ thread: channel.id }))
      yield* discord.updateOriginalWebhookMessage(
        application.id,
        context.token,
        { payload: { content: response.text } }
      )
    },
    Effect.catchAllCause(Effect.log),
    Effect.provide(model)
  )

  const ix = Ix.builder
    .add(command)
    .catchTagRespond("NotInThreadError", () =>
      Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "This command can only be used in a thread",
            flags: Discord.MessageFlags.Ephemeral
          }
        })
      ))
    .catchAllCause(Effect.logError)

  yield* registry.register(ix)
})

export const ReproRequesterLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(OpenAiLive),
  Layer.provide(DiscordGatewayLayer)
)
