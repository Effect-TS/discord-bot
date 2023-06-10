import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI, OpenAIMessage } from "bot/OpenAI"
import { Chunk, Config, Data, Effect, Layer, Stream, pipe } from "bot/_common"
import { Discord, Ix } from "dfx"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"
import { Messages, MessagesLive } from "bot/Messages"
import { Github } from "bot/Github"
import { Summarizer, SummarizerLive } from "bot/Summarizer"

export interface IssueifierConfig {
  readonly githubRepo: string
}

export class NotInThreadError extends Data.TaggedClass(
  "NotInThreadError",
)<{}> {}

const make = ({ githubRepo }: IssueifierConfig) =>
  Effect.gen(function* (_) {
    const channels = yield* _(ChannelsCache)
    const openai = yield* _(OpenAI)
    const messages = yield* _(Messages)
    const registry = yield* _(InteractionsRegistry)
    const scope = yield* _(Effect.scope())
    const github = yield* _(Github)
    const summarizer = yield* _(Summarizer)

    const [repoOwner, repoName] = githubRepo.split("/")
    const createGithubIssue = github.wrap(_ => _.issues.create)

    const createIssue = (channel: Discord.Channel) =>
      pipe(
        messages.cleanForChannel(channel),
        Stream.runCollect,
        Effect.bindTo("messages"),
        Effect.let("openAiMessages", ({ messages }) =>
          Chunk.map(
            messages,
            (msg): OpenAIMessage => ({
              bot: false,
              content: msg.content,
            }),
          ),
        ),
        Effect.flatMap(({ openAiMessages, messages }) =>
          Effect.all({
            summary: openai.generateSummary(
              channel.name!,
              Chunk.toReadonlyArray(openAiMessages),
            ),
            fullThread: summarizer.withMessages(channel, messages),
          }),
        ),
        Effect.flatMap(({ summary, fullThread }) =>
          createGithubIssue({
            owner: repoOwner,
            repo: repoName,
            title: `From Discord Bot: ${channel.name}`,
            body: `## Summary
${summary}

## Full thread

<details>
<summary>Click to expand</summary>

${fullThread}

</details>`,
          }),
        ),
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

export const makeLayer = (config: Config.Config.Wrap<IssueifierConfig>) =>
  Layer.provide(
    Layer.mergeAll(
      ChannelsCacheLive,
      InteractionsRegistryLive,
      MessagesLive,
      SummarizerLive,
    ),
    Layer.scopedDiscard(
      Effect.flatMap(Effect.config(Config.unwrap(config)), make),
    ),
  )
