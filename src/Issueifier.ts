import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI, OpenAIMessage } from "bot/OpenAI"
import { Chunk, Data, Effect, Layer, Stream, pipe } from "bot/_common"
import { Discord, Ix } from "dfx"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"
import { Messages, MessagesLive } from "bot/Messages"

export class NotInThreadError extends Data.TaggedClass(
  "NotInThreadError",
)<{}> {}

const make = Effect.gen(function* (_) {
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI)
  const messages = yield* _(Messages)
  const registry = yield* _(InteractionsRegistry)
  const scope = yield* _(Effect.scope())

  const createIssue = (channel: Discord.Channel) =>
    pipe(
      messages.cleanForChannel(channel),
      Stream.runCollect,
      Effect.map(messages =>
        Chunk.map(
          messages,
          (msg): OpenAIMessage => ({
            bot: false,
            content: msg.content,
          }),
        ),
      ),
      Effect.flatMap(messages =>
        openai.generateSummary(channel.name!, Chunk.toReadonlyArray(messages)),
      ),
      Effect.tap(summary => Effect.sync(() => console.log(summary))),
    )

  const command = Ix.global(
    {
      name: "issueify",
      description:
        "Convert this thread into an issue for the Effect Website repo",
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
      Effect.tap(({ channel }) => Effect.forkIn(createIssue(channel), scope)),
      Effect.as(
        Ix.response({
          type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Creating issue on Github...",
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

export const IssueifierLive = Layer.provide(
  Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive, MessagesLive),
  Layer.scopedDiscard(make),
)
