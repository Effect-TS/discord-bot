import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { DiscordApplication } from "@chat/discord/DiscordRest"
import { MemberCache } from "@chat/discord/MemberCache"
import { Messages } from "@chat/discord/Messages"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import {
  Cause,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  ServiceMap,
  Stream,
} from "effect"
import { constTrue } from "effect/Function"
import { ChannelsCache } from "./ChannelsCache.ts"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError",
)<{}> {}

export class Summarizer extends ServiceMap.Service<Summarizer>()(
  "app/Summarizer",
  {
    make: Effect.gen(function* () {
      const rest = yield* DiscordREST
      const channels = yield* ChannelsCache
      const registry = yield* InteractionsRegistry
      const members = yield* MemberCache
      const messagesService = yield* Messages
      const scope = yield* Effect.scope
      const application = yield* DiscordApplication

      const summarizeThread = Effect.fn("Summarizer.summarizeThread")(
        function* (channel: Discord.ThreadResponse, small: boolean = true) {
          const parentChannel = yield* channels.get(
            channel.guild_id!,
            channel.parent_id!,
          )
          const threadMessages = yield* Stream.runCollect(
            messagesService.cleanForChannel(channel),
          ).pipe(Effect.map((items) => [...items].toReversed()))
          return yield* summarize(parentChannel, channel, threadMessages, small)
        },
      )

      const summarizeWithMessages = (
        channel: Discord.ThreadResponse,
        messages: Array<Discord.MessageResponse>,
        small = true,
      ) =>
        pipe(
          channels.get(channel.guild_id!, channel.parent_id!),
          Effect.flatMap((parentChannel) =>
            summarize(parentChannel, channel, messages, small),
          ),
          Effect.withSpan("Summarizer.summarizeWithMessages"),
        )

      const summarize = (
        channel: Discord.GetChannel200,
        thread: Discord.ThreadResponse,
        messages: Array<Discord.MessageResponse>,
        small: boolean,
      ) => {
        const channelName = "name" in channel ? channel.name : "unknown-channel"
        return Effect.forEach(
          messages,
          (message, index) => {
            const reply = pipe(
              Option.fromNullishOr(message.message_reference),
              Option.flatMap((ref) => {
                const foundIndex = messages.findIndex(
                  (_) => _.id === ref.message_id,
                )
                return foundIndex >= 0
                  ? Option.some([messages[foundIndex], foundIndex + 1] as const)
                  : Option.none<readonly [Discord.MessageResponse, number]>()
              }),
            )
            return summarizeMessage(thread, index + 1, message, reply, small)
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(
            (messageContent) =>
              `# ${thread.name}

Thread started in: #${channelName}<br />
Thread started at: ${new Date(
                thread.thread_metadata!.create_timestamp!,
              ).toUTCString()}

${messageContent.join("\n\n")}`,
          ),
          Effect.withSpan("Summarizer.summarize"),
        )
      }

      const summarizeMessage = Effect.fn("Summarizer.summarizeMessage")(
        function* (
          thread: Discord.ThreadResponse,
          index: number,
          message: Discord.MessageResponse,
          replyTo: Option.Option<readonly [Discord.MessageResponse, number]>,
          small: boolean,
        ) {
          yield* Effect.annotateCurrentSpan({
            channelId: thread.id,
            messageId: message.id,
          })

          const user = message.author
          const member = yield* members.get(thread.guild_id!, message.author.id)
          const username = member.nick ?? user.username

          const smallOpen = small ? "<small>" : ""
          const smallClose = small ? "</small>" : ""

          const reply = Option.match(replyTo, {
            onNone: () => "",
            onSome: ([, i]) => ` (replying to \\#${i})`,
          })

          const header = `${smallOpen}${index}: **${username}**${reply} ${smallOpen}&mdash; ${new Date(
            message.timestamp,
          ).toUTCString()}${smallClose}${smallClose}`

          const images = message.attachments.filter((_) =>
            _.content_type?.startsWith("image/"),
          )
          const imagesContent =
            images.length > 0
              ? "\n\n" + images.map((_) => `![Attachment](${_.url})`).join("\n")
              : ""

          return `${header}<br />
${message.content}${imagesContent}`
        },
      )

      const followUpResponse = (
        context: Discord.APIInteraction,
        channel: Discord.ThreadResponse,
        small: boolean,
      ) =>
        pipe(
          summarizeThread(channel, small),
          Effect.tap((summary) =>
            pipe(
              rest.updateOriginalWebhookMessage(application.id, context.token, {
                payload: { content: "Here is your summary!" },
              }),
              rest.withFiles([
                new File([summary], `${channel.name} Summary.md`, {
                  type: "text/plain",
                }),
              ]),
            ),
          ),
          Effect.catchCause((cause) =>
            rest.updateOriginalWebhookMessage(application.id, context.token, {
              payload: {
                content:
                  "Could not create summary. Here are the full error details:\n\n```" +
                  Cause.pretty(cause) +
                  "\n```",
              },
            }),
          ),
          Effect.withSpan("Summarizer.followUpResponse", {
            attributes: {
              channelId: channel.id,
              small,
            },
          }),
        )

      const command = Ix.global(
        {
          name: "summarize",
          description: "Create a summary of the current thread",
          options: [
            {
              type: Discord.ApplicationCommandOptionType.BOOLEAN,
              name: "small",
              description: "Add <small> tags to the message headers",
              required: false,
            },
          ],
        },
        Effect.fn("Summarizer.command")(function* (ix) {
          const context = yield* Ix.Interaction
          const small = ix.optionValueOrElse("small", constTrue)
          const channel = yield* channels.get(
            context.guild_id!,
            context.channel!.id,
          )

          yield* Effect.annotateCurrentSpan({
            channelId: channel.id,
            small,
          })

          if (channel.type !== Discord.ChannelTypes.PUBLIC_THREAD) {
            return yield* new NotInThreadError()
          }

          yield* Effect.forkIn(followUpResponse(context, channel, small), scope)

          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "Creating summary...",
              flags: Discord.MessageFlags.Ephemeral,
            },
          })
        }),
      )

      const ix = Ix.builder
        .add(command)
        .catchTagRespond("NotInThreadError", () =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes
                .CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: "This command can only be used in a thread",
                flags: Discord.MessageFlags.Ephemeral,
              },
            }),
          ),
        )
        .catchAllCause(Effect.logError)

      yield* registry.register(ix)

      return {
        thread: summarizeThread,
        messages: summarizeWithMessages,
        message: summarizeMessage,
      } as const
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(ChannelsCache.layer),
    Layer.provide(MemberCache.layer),
    Layer.provide(Messages.layer),
    Layer.provide(DiscordGatewayLayer),
  )
}
