import { DiscordApplication, DiscordRestLayer } from "@chat/discord/DiscordRest"
import { Conversation } from "@chat/domain/Conversation"
import { AiChat, AiInput } from "@effect/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { Discord, DiscordREST } from "dfx"
import { Effect, Fiber, Layer, Option } from "effect"
import "@effect/platform"
import { OpenAiLayer } from "./OpenAi.ts"

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
          const messagesFiber = yield* discord.listMessages(threadId, {
            limit: 10
          }).pipe(Effect.fork)
          const channel = yield* discord.getChannel(threadId)
          const openingMessage = yield* Effect.succeed(channel).pipe(
            Effect.filterOrFail((thread): thread is Discord.ThreadResponse =>
              "parent_id" in thread
            ),
            Effect.flatMap((thread) =>
              discord.getMessage(thread.parent_id!, thread.id)
            ),
            Effect.option
          )
          const messages = yield* Fiber.join(messagesFiber)

          return {
            history: AiInput.make(
              Option.match(openingMessage, {
                onNone: () => messages,
                onSome: (openingMessage) => [...messages, openingMessage]
              }).slice()
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
                    msg.author.id === botUser.id ?
                      new AiInput.AssistantMessage({
                        parts: [new AiInput.TextPart({ text: msg.content })]
                      }) :
                      new AiInput.UserMessage({
                        parts: [new AiInput.TextPart({ text: msg.content })],
                        userName: msg.author.username
                      })
                )
            ),
            thread: "name" in channel ? channel.name! : undefined
          }
        }
      )

      return { forDiscordChannel } as const
    })
  })
{}

const systemPrompt = (thread?: string) =>
  `You are Effect Bot, a friendly, helpful assistant for the Effect Discord community.

Please keep replies under 2000 characters.${
    thread ?
      `

The title of this conversation is "${thread}".` :
      ""
  }
`

export const ConversationEntity = Conversation.toLayer(
  Effect.gen(function*() {
    const history = yield* ConversationHistory
    let chat: AiChat.AiChat.Service | undefined = undefined
    const model = yield* OpenAiLanguageModel.model("gpt-4o")

    return {
      send: Effect.fnUntraced(function*({ payload }) {
        if (!chat) {
          const result = yield* history.forDiscordChannel(
            payload.address.discordChannelId,
            payload.messageId
          ).pipe(
            Effect.orElseSucceed(() => ({
              history: AiInput.empty,
              thread: undefined
            }))
          )
          chat = yield* AiChat.fromPrompt({
            prompt: result.history,
            system: systemPrompt(result.thread)
          })
        }
        const response = yield* chat.generateText({ prompt: payload.message })
        return response.text
      }, model.use)
    }
  }),
  { maxIdleTime: "10 minutes" }
).pipe(
  Layer.provide([ConversationHistory.Default, OpenAiLayer])
)
