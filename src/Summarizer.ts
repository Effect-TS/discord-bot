import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordLive } from "bot/Discord"
import { MemberCache } from "bot/MemberCache"
import { Messages } from "bot/Messages"
import { Http } from "bot/_common"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import {
  Cause,
  Chunk,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Stream,
  pipe,
} from "effect"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError",
)<{}> {}

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache
  const registry = yield* InteractionsRegistry
  const members = yield* MemberCache
  const messages = yield* Messages
  const scope = yield* Effect.scope
  const application = yield* rest.getCurrentBotApplicationInformation().json

  const summarizeThread = (channel: Discord.Channel, small = true) =>
    pipe(
      Effect.all({
        parentChannel: channels.get(channel.guild_id!, channel.parent_id!),
        messages: Effect.map(
          Stream.runCollect(messages.cleanForChannel(channel)),
          Chunk.reverse,
        ),
      }),
      Effect.flatMap(({ parentChannel, messages }) =>
        summarize(parentChannel, channel, messages, small),
      ),
      Effect.withSpan("Summarizer.summarizeThread"),
    )

  const summarizeWithMessages = (
    channel: Discord.Channel,
    messages: Chunk.Chunk<Discord.Message>,
    small = true,
  ) =>
    pipe(
      channels.get(channel.guild_id!, channel.parent_id!),
      Effect.flatMap(parentChannel =>
        summarize(parentChannel, channel, messages, small),
      ),
      Effect.withSpan("Summarizer.summarizeWithMessages"),
    )

  const summarize = (
    channel: Discord.Channel,
    thread: Discord.Channel,
    messages: Chunk.Chunk<Discord.Message>,
    small: boolean,
  ) =>
    Effect.forEach(
      messages,
      (message, index) => {
        const reply = pipe(
          Option.fromNullable(message.message_reference),
          Option.flatMap(ref =>
            Chunk.findFirstIndex(messages, _ => _.id === ref.message_id),
          ),
          Option.map(
            index => [Chunk.unsafeGet(messages, index), index + 1] as const,
          ),
        )
        return summarizeMessage(thread, index + 1, message, reply, small)
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(
        messageContent =>
          `# ${thread.name}

Thread started in: #${channel.name}<br />
Thread started at: ${new Date(
            thread.thread_metadata!.create_timestamp!,
          ).toUTCString()}

${messageContent.join("\n\n")}`,
      ),
      Effect.withSpan("Summarizer.summarize"),
    )

  const summarizeMessage = (
    thread: Discord.Channel,
    index: number,
    message: Discord.Message,
    replyTo: Option.Option<readonly [Discord.Message, number]>,
    small: boolean,
  ) =>
    Effect.gen(function* () {
      const user = message.author
      const member = yield* members.get(thread.guild_id!, message.author.id)
      const username = member.nick ?? user.username

      const smallOpen = small ? "<small>" : ""
      const smallClose = small ? "</small>" : ""

      const reply = Option.match(replyTo, {
        onNone: () => "",
        onSome: ([, index]) => ` (replying to \\#${index})`,
      })

      const header = `${smallOpen}${index}: **${username}**${reply} ${smallOpen}&mdash; ${new Date(
        message.timestamp,
      ).toUTCString()}${smallClose}${smallClose}`

      const images = message.attachments.filter(_ =>
        _.content_type?.startsWith("image/"),
      )
      const imagesContent =
        images.length > 0
          ? "\n\n" + images.map(_ => `![Attachment](${_.url})`).join("\n")
          : ""

      return `${header}<br />
${message.content}${imagesContent}`
    }).pipe(
      Effect.withSpan("Summarizer.summarizeMessage", {
        attributes: {
          channelId: thread.id,
          messageId: message.id,
        },
      }),
    )

  const followUpResponse = (
    context: Discord.Interaction,
    channel: Discord.Channel,
    small: boolean,
  ) =>
    pipe(
      summarizeThread(channel, small),
      Effect.tap(summary => {
        const formData = new FormData()

        formData.append(
          "file",
          new Blob([summary], { type: "text/plain" }),
          `${channel.name} Summary.md`,
        )

        return rest.editOriginalInteractionResponse(
          application.id,
          context.token,
          { content: "Here is your summary!" },
          { body: Http.body.formData(formData) },
        )
      }),
      Effect.catchAllCause(cause =>
        rest.editOriginalInteractionResponse(application.id, context.token, {
          content:
            "Could not create summary. Here are the full error details:\n\n```" +
            Cause.pretty(cause) +
            "\n```",
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
    ix =>
      pipe(
        Effect.all({
          context: Ix.Interaction,
          small: Effect.map(
            ix.optionValueOptional("small"),
            Option.getOrElse(() => true),
          ),
        }),
        Effect.bind("channel", ({ context }) =>
          channels.get(context.guild_id!, context.channel_id!),
        ),
        Effect.tap(({ channel, small }) =>
          Effect.annotateCurrentSpan({
            channelId: channel.id,
            small,
          }),
        ),
        Effect.filterOrFail(
          ({ channel }) => channel.type === Discord.ChannelType.PUBLIC_THREAD,
          () => new NotInThreadError(),
        ),
        Effect.tap(({ context, channel, small }) =>
          Effect.forkIn(followUpResponse(context, channel, small), scope),
        ),
        Effect.as(
          Ix.response({
            type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "Creating summary...",
              flags: Discord.MessageFlag.EPHEMERAL,
            },
          }),
        ),
        Effect.withSpan("Summarizer.command"),
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

  return {
    thread: summarizeThread,
    messages: summarizeWithMessages,
    message: summarizeMessage,
  } as const
})

export class Summarizer extends Context.Tag("app/Summarizer")<
  Summarizer,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.scoped(Summarizer, make).pipe(
    Layer.provide(
      Layer.mergeAll(
        ChannelsCache.Live,
        MemberCache.Live,
        Messages.Live,
        DiscordLive,
      ),
    ),
  )
}
