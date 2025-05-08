import { DiscordApplication, DiscordRestLayer } from "@chat/discord/DiscordRest"
import { Conversation } from "@chat/domain/Conversation"
import { AiChat, AiInput, AiRole } from "@effect/ai"
import { Discord, DiscordREST } from "dfx"
import { Effect, Fiber, Option } from "effect"
import "@effect/platform"

export const ConversationEntity = Conversation.toLayer(
  Effect.gen(function*() {
    const history = yield* ConversationHistory
    let chat: AiChat.AiChat.Service | undefined = undefined

    return {
      send: Effect.fnUntraced(function*({ payload }) {
        if (!chat) {
          const input = yield* history.forDiscordChannel(
            payload.address.discordChannelId,
            payload.messageId
          ).pipe(
            Effect.orElseSucceed(() => AiInput.empty)
          )
          chat = yield* AiChat.fromInput(input)
        }
        const response = yield* chat.send(payload.message)
        return response.text
      })
    }
  }),
  { maxIdleTime: "10 minutes" }
)
// Layer.provide(Layer.succeed(AiInput.SystemInstruction, ``))

export class ConversationHistory
  extends Effect.Service<ConversationHistory>()("ConversationHistory", {
    dependencies: [DiscordRestLayer, DiscordApplication.Default],
    effect: Effect.gen(function*() {
      const discord = yield* DiscordREST
      const botUser = yield* DiscordApplication

      const forDiscordChannel = Effect.fn(
        "ConversationHistory.forDiscordChannel"
      )(
        function*(threadId: string, excludeMessageId: string) {
          const messagesFiber = yield* discord.getChannelMessages(threadId, {
            limit: 10
          }).json.pipe(Effect.fork)
          const openingMessage = yield* discord.getChannel(threadId).json.pipe(
            Effect.flatMap((thread) =>
              discord.getChannelMessage(thread.parent_id!, thread.id).json
            ),
            Effect.option
          )
          const messages = yield* Fiber.join(messagesFiber)

          return AiInput.make(
            Option.match(openingMessage, {
              onNone: () => messages,
              onSome: (openingMessage) => [...messages, openingMessage]
            })
              .reverse()
              .filter(
                (msg) =>
                  msg.type === Discord.MessageType.DEFAULT ||
                  msg.type === Discord.MessageType.REPLY
              )
              .filter((msg) =>
                msg.id !== excludeMessageId && msg.content.trim().length > 0
              )
              .map(
                (msg): AiInput.Message =>
                  AiInput.Message.fromInput(
                    msg.content,
                    msg.author.id === botUser.id
                      ? AiRole.model
                      : AiRole.userWithName(msg.author.username)
                  )
              )
          )
        }
      )

      return { forDiscordChannel } as const
    })
  })
{}
