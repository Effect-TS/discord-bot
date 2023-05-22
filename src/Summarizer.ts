import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { MemberCache, MemberCacheLive } from "bot/MemberCache"
import {
  Cause,
  Chunk,
  Data,
  Effect,
  Http,
  Layer,
  Option,
  Stream,
  pipe,
} from "bot/_common"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"

export class NotInThreadError extends Data.TaggedClass(
  "NotInThreadError",
)<{}> {}

export class PermissionsError extends Data.TaggedClass("PermissionsError")<{
  readonly action: string
  readonly subject: string
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const channels = yield* _(ChannelsCache)
  const registry = yield* _(InteractionsRegistry)
  const members = yield* _(MemberCache)
  const scope = yield* _(Effect.scope())
  const application = yield* _(
    Effect.flatMap(rest.getCurrentBotApplicationInformation(), _ => _.json),
  )

  const getAllMessages = (channelId: string) =>
    pipe(
      Stream.paginateChunkEffect(Option.none<Discord.Snowflake>(), before =>
        pipe(
          rest.getChannelMessages(channelId, {
            limit: 100,
            before: Option.getOrUndefined(before),
          }),
          Effect.flatMap(_ => _.json),
          Effect.map(messages =>
            messages.length < 100
              ? ([
                  Chunk.unsafeFromArray(messages),
                  Option.none<Option.Option<Discord.Snowflake>>(),
                ] as const)
              : ([
                  Chunk.unsafeFromArray(messages),
                  Option.some(Option.some(messages[messages.length - 1].id)),
                ] as const),
          ),
        ),
      ),

      // only include normal messages
      Stream.flatMapPar(Number.MAX_SAFE_INTEGER, msg => {
        if (msg.type === Discord.MessageType.THREAD_STARTER_MESSAGE) {
          return Effect.flatMap(
            rest.getChannelMessage(
              msg.message_reference!.channel_id!,
              msg.message_reference!.message_id!,
            ),
            _ => _.json,
          )
        } else if (
          msg.content !== "" &&
          (msg.type === Discord.MessageType.REPLY ||
            msg.type === Discord.MessageType.DEFAULT)
        ) {
          return Stream.succeed(msg)
        }

        return Stream.empty
      }),
    )

  const summarize = (
    channel: Discord.Channel,
    thread: Discord.Channel,
    messages: Chunk.Chunk<Discord.Message>,
  ) =>
    Effect.map(
      Effect.forEachParWithIndex(messages, (message, index) => {
        const reply = pipe(
          Option.fromNullable(message.message_reference),
          Option.flatMap(ref =>
            Chunk.findFirstIndex(messages, _ => _.id === ref.message_id),
          ),
          Option.map(
            index => [Chunk.unsafeGet(messages, index), index + 1] as const,
          ),
        )
        return summarizeMessage(thread, index + 1, message, reply)
      }),
      messageContent =>
        `# ${thread.name}

Thread started in: #${channel.name}<br />
Thread started at: ${new Date(
          thread.thread_metadata!.create_timestamp!,
        ).toUTCString()}

${messageContent.join("\n\n")}`,
    )

  const summarizeMessage = (
    thread: Discord.Channel,
    index: number,
    message: Discord.Message,
    replyTo: Option.Option<readonly [Discord.Message, number]>,
  ) =>
    Effect.gen(function* (_) {
      const user = message.author
      const member = yield* _(members.get(thread.guild_id!, message.author.id))
      const username = member.nick ?? user.username
      const content = `${index}: **${username}**${Option.match(
        replyTo,
        () => "",
        ([, index]) => ` (replying to \\#${index})`,
      )} <small>&mdash; ${new Date(
        message.timestamp,
      ).toUTCString()}</small><br />
${message.content
  .replace(/```ts\b/g, "```typescript")
  .replace(/^```/, "\n```")
  .replace(/[^\n]```/gm, "\n\n```")
  .replace(/([^\n])\n```/gm, "$1\n\n```")}`

      const mentions = yield* _(
        Effect.forEachPar(content.matchAll(/<@(\d+)>/g), ([, userId]) =>
          Effect.option(
            members.get(thread.guild_id!, userId as Discord.Snowflake),
          ),
        ),
      )

      return mentions.reduce(
        (content, member) =>
          Option.match(
            member,
            () => content,
            member =>
              content.replace(
                new RegExp(`<@${member.user!.id}>`, "g"),
                `**@${member.nick ?? member.user!.username}**`,
              ),
          ),
        content,
      )
    })

  const followUpResponse = (
    context: Discord.Interaction,
    channel: Discord.Channel,
  ) =>
    pipe(
      Effect.all({
        parentChannel: channels.get(channel.guild_id!, channel.parent_id!),
      }),
      Effect.bind("messages", () =>
        Effect.map(
          Stream.runCollect(getAllMessages(channel.id)),
          Chunk.reverse,
        ),
      ),
      Effect.bind("summary", ({ parentChannel, messages }) =>
        summarize(parentChannel, channel, messages),
      ),
      Effect.tap(({ summary }) => {
        const formData = new FormData()

        formData.append(
          "file",
          new Blob([summary], { type: "text/plain" }),
          `${channel.name} Summary.md`,
        )
        formData.append(
          "payload_json",
          JSON.stringify({ content: "Here is your summary!" }),
        )

        return rest.editOriginalInteractionResponse(
          application.id,
          context.token,
          { body: Http.body.formData(formData) },
        )
      }),
      Effect.catchAllCause(cause =>
        rest.editOriginalInteractionResponse(application.id, context.token, {
          body: Http.body.json({
            content:
              "Could not create summary. Here are the full error details:\n\n```" +
              Cause.pretty(cause) +
              "\n```",
          }),
        }),
      ),
    )

  const command = Ix.global(
    {
      name: "summarize",
      description: "Create a summary of the current thread",
    },
    pipe(
      Effect.all({ context: Ix.Interaction }),
      Effect.bind("channel", ({ context }) =>
        channels.get(context.guild_id!, context.channel_id!),
      ),
      Effect.filterOrFail(
        ({ channel }) => channel.type === Discord.ChannelType.PUBLIC_THREAD,
        () => new NotInThreadError(),
      ),
      Effect.tap(({ context, channel }) =>
        Effect.forkIn(followUpResponse(context, channel), scope),
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
    .catchAllCause(Effect.logErrorCause)

  yield* _(registry.register(ix))
})

export const SummarizerLive = Layer.provide(
  Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive, MemberCacheLive),
  Layer.scopedDiscard(make),
)
