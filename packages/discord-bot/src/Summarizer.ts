import { HttpBody } from "@effect/platform"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Cause, Chunk, Data, Effect, Option, pipe, Stream } from "effect"
import { constTrue } from "effect/Function"
import { ChannelsCache } from "./ChannelsCache.ts"
import { DiscordApplication, DiscordLive } from "./Discord.ts"
import { MemberCache } from "./MemberCache.ts"
import { Messages } from "./Messages.ts"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError"
)<{}> {}

export class Summarizer extends Effect.Service<Summarizer>()("app/Summarizer", {
  scoped: Effect.gen(function*() {
    const rest = yield* DiscordREST
    const channels = yield* ChannelsCache
    const registry = yield* InteractionsRegistry
    const members = yield* MemberCache
    const messages = yield* Messages
    const scope = yield* Effect.scope
    const application = yield* DiscordApplication

    const summarizeThread = Effect.fn("Summarizer.summarizeThread")(function*(
      channel: Discord.Channel,
      small: boolean = true
    ) {
      const parentChannel = yield* channels.get(
        channel.guild_id!,
        channel.parent_id!
      )
      const threadMessages = yield* Stream.runCollect(
        messages.cleanForChannel(channel)
      ).pipe(Effect.map(Chunk.reverse))
      return yield* summarize(parentChannel, channel, threadMessages, small)
    })

    const summarizeWithMessages = (
      channel: Discord.Channel,
      messages: Chunk.Chunk<Discord.Message>,
      small = true
    ) =>
      pipe(
        channels.get(channel.guild_id!, channel.parent_id!),
        Effect.flatMap((parentChannel) => summarize(parentChannel, channel, messages, small)),
        Effect.withSpan("Summarizer.summarizeWithMessages")
      )

    const summarize = (
      channel: Discord.Channel,
      thread: Discord.Channel,
      messages: Chunk.Chunk<Discord.Message>,
      small: boolean
    ) =>
      Effect.forEach(
        messages,
        (message, index) => {
          const reply = pipe(
            Option.fromNullable(message.message_reference),
            Option.flatMap((ref) => Chunk.findFirstIndex(messages, (_) => _.id === ref.message_id)),
            Option.map(
              (index) => [Chunk.unsafeGet(messages, index), index + 1] as const
            )
          )
          return summarizeMessage(thread, index + 1, message, reply, small)
        },
        { concurrency: "unbounded" }
      ).pipe(
        Effect.map(
          (messageContent) =>
            `# ${thread.name}

Thread started in: #${channel.name}<br />
Thread started at: ${
              new Date(
                thread.thread_metadata!.create_timestamp!
              ).toUTCString()
            }

${messageContent.join("\n\n")}`
        ),
        Effect.withSpan("Summarizer.summarize")
      )

    const summarizeMessage = Effect.fn("Summarizer.summarizeMessage")(
      function*(
        thread: Discord.Channel,
        index: number,
        message: Discord.Message,
        replyTo: Option.Option<readonly [Discord.Message, number]>,
        small: boolean
      ) {
        yield* Effect.annotateCurrentSpan({
          channelId: thread.id,
          messageId: message.id
        })

        const user = message.author
        const member = yield* members.get(thread.guild_id!, message.author.id)
        const username = member.nick ?? user.username

        const smallOpen = small ? "<small>" : ""
        const smallClose = small ? "</small>" : ""

        const reply = Option.match(replyTo, {
          onNone: () => "",
          onSome: ([, index]) => ` (replying to \\#${index})`
        })

        const header = `${smallOpen}${index}: **${username}**${reply} ${smallOpen}&mdash; ${
          new Date(
            message.timestamp
          ).toUTCString()
        }${smallClose}${smallClose}`

        const images = message.attachments.filter((_) => _.content_type?.startsWith("image/"))
        const imagesContent = images.length > 0
          ? "\n\n" + images.map((_) => `![Attachment](${_.url})`).join("\n")
          : ""

        return `${header}<br />
${message.content}${imagesContent}`
      }
    )

    const followUpResponse = (
      context: Discord.Interaction,
      channel: Discord.Channel,
      small: boolean
    ) =>
      pipe(
        summarizeThread(channel, small),
        Effect.tap((summary) => {
          const formData = new FormData()

          formData.append(
            "file",
            new Blob([summary], { type: "text/plain" }),
            `${channel.name} Summary.md`
          )

          return rest.editOriginalInteractionResponse(
            application.id,
            context.token,
            { content: "Here is your summary!" },
            { body: HttpBody.formData(formData) }
          )
        }),
        Effect.catchAllCause((cause) =>
          rest.editOriginalInteractionResponse(application.id, context.token, {
            content: "Could not create summary. Here are the full error details:\n\n```" +
              Cause.pretty(cause) +
              "\n```"
          })
        ),
        Effect.withSpan("Summarizer.followUpResponse", {
          attributes: {
            channelId: channel.id,
            small
          }
        })
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
            required: false
          }
        ]
      },
      Effect.fn("Summarizer.command")(function*(ix) {
        const context = yield* Ix.Interaction
        const small = ix.optionValueOrElse("small", constTrue)
        const channel = yield* channels.get(
          context.guild_id!,
          context.channel_id!
        )

        yield* Effect.annotateCurrentSpan({
          channelId: channel.id,
          small
        })

        if (channel.type !== Discord.ChannelType.PUBLIC_THREAD) {
          return yield* new NotInThreadError()
        }

        yield* Effect.forkIn(followUpResponse(context, channel, small), scope)

        return Ix.response({
          type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Creating summary...",
            flags: Discord.MessageFlag.EPHEMERAL
          }
        })
      })
    )

    const ix = Ix.builder
      .add(command)
      .catchTagRespond("NotInThreadError", () =>
        Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "This command can only be used in a thread",
              flags: Discord.MessageFlag.EPHEMERAL
            }
          })
        ))
      .catchAllCause(Effect.logError)

    yield* registry.register(ix)

    return {
      thread: summarizeThread,
      messages: summarizeWithMessages,
      message: summarizeMessage
    } as const
  }),
  dependencies: [
    ChannelsCache.Default,
    MemberCache.Default,
    Messages.Default,
    DiscordLive
  ]
}) {}
