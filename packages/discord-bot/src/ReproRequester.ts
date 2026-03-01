import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { DiscordApplication } from "@chat/discord/DiscordRest"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Effect, Layer } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { AiHelpers, ChatModel, OpenAiLive } from "./Ai.ts"
import { ChannelsCache } from "./ChannelsCache.ts"
import { NotInThreadError } from "./Summarizer.ts"

const systemInstruction = `You are Effect Bot, a helpful assistant for the Effect Discord community.

Generate a short funny message to the user that a minimal reproduction of the issue is required for further investigation.`

const make = Effect.gen(function* () {
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
      description:
        "Generate a message indicating that reproduction is required",
    },
    Effect.fn("ReproRequester.command")(
      function* (ix) {
        const context = ix.interaction
        const channel = yield* channels.get(
          context.guild_id!,
          context.channel!.id,
        )
        if (channel.type !== Discord.ChannelTypes.PUBLIC_THREAD) {
          return yield* new NotInThreadError()
        }
        yield* respond(channel, context).pipe(Effect.forkIn(scope))
        return Ix.response({
          type: Discord.InteractionCallbackTypes
            .DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        })
      },
      Effect.annotateLogs("command", "repro"),
    ),
  )

  const respond = Effect.fn("ReproRequester.respond")(
    function* (
      channel: Discord.ThreadResponse,
      context: Discord.APIInteraction,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: channel.id })
      const input = yield* ai.generateAiInput(channel)
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.concat(
          Prompt.make([
            {
              role: "system",
              content: systemInstruction,
            },
          ]),
          input,
        ),
      }).pipe(Effect.annotateLogs({ thread: channel.id }))
      yield* discord.updateOriginalWebhookMessage(
        application.id,
        context.token,
        { payload: { content: response.text } },
      )
    },
    Effect.catchCause(Effect.log),
    Effect.provide(model),
  )

  const ix = Ix.builder
    .add(command)
    .catchTagRespond("NotInThreadError", () =>
      Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "This command can only be used in a thread",
            flags: Discord.MessageFlags.Ephemeral,
          },
        }),
      ),
    )
    .catchAllCause(Effect.logError)

  yield* registry.register(ix)
})

export const ReproRequesterLive = Layer.effectDiscard(make).pipe(
  Layer.provide(AiHelpers.layer),
  Layer.provide(ChannelsCache.layer),
  Layer.provide(OpenAiLive),
  Layer.provide(DiscordGatewayLayer),
)
