import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { DiscordApplication } from "@chat/discord/DiscordRest"
import { Conversation, DiscordThread } from "@chat/domain/Conversation"
import { Discord, DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"
import { Data, Effect, Layer } from "effect"
import { ChannelsCache } from "./ChannelsCache.ts"
import { ClusterLayer } from "./Cluster.ts"
import * as Str from "./utils/String.ts"

class NonEligibleMessage extends Data.TaggedError("NonEligibleMessage")<{
  readonly reason: "non-mentioned" | "not-in-thread" | "from-bot"
}> {}

const make = Effect.gen(function*() {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const channels = yield* ChannelsCache
  const makeConversation = yield* Conversation.client

  const application = yield* DiscordApplication
  const botUser = application.bot!

  //   const generateCompletion = (
  //     thread: Discord.Channel,
  //     message: Discord.MessageCreateEvent
  //   ) =>
  //     ai.generateAiInput(thread, message).pipe(
  //       Effect.flatMap((prompt) =>
  //         AiLanguageModel.generateText({
  //           prompt,
  //           system:
  //             `You are Effect Bot, a funny, helpful assistant for the Effect Discord community.
  //
  // Please keep replies under 2000 characters.
  //
  // The title of this conversation is "${thread.name ?? "A thread"}".`
  //         })
  //       ),
  //       model.use,
  //       Effect.map((r) => r.text)
  //     )

  const run = gateway.handleDispatch(
    "MESSAGE_CREATE",
    Effect.fnUntraced(
      function*(message) {
        if (message.author.bot) {
          return yield* new NonEligibleMessage({ reason: "from-bot" })
        }
        if (!message.mentions.some((_) => _.id === botUser.id)) {
          return yield* new NonEligibleMessage({ reason: "non-mentioned" })
        }

        const channel = yield* channels.get(
          message.guild_id!,
          message.channel_id
        )
        if (channel.type !== Discord.ChannelTypes.PUBLIC_THREAD) {
          return yield* new NonEligibleMessage({ reason: "not-in-thread" })
        }

        const conversation = makeConversation(channel.id)
        const content = yield* conversation.send({
          address: new DiscordThread({ threadId: channel.id }),
          messageId: message.id,
          message: message.content
        })

        yield* rest.createMessage(message.channel_id, {
          message_reference: { message_id: message.id },
          content: Str.truncate(content, 2000)
        })
      },
      Effect.catchTags({
        NonEligibleMessage: (_) => Effect.void
      }),
      (effect, message) =>
        Effect.withSpan(effect, "Mentions.handleMessage", {
          attributes: { messageId: message.id }
        }),
      Effect.catchAllCause(Effect.logError)
    )
  )

  yield* Effect.forkScoped(run)
})

export const MentionsLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordGatewayLayer),
  Layer.provide(ClusterLayer)
)
