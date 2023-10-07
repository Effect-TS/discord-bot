import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Github } from "bot/Github"
import { Messages, MessagesLive } from "bot/Messages"
import { OpenAI, OpenAIMessage } from "bot/OpenAI"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"
import {
  Chunk,
  Effect,
  Data,
  Layer,
  Option,
  ReadonlyArray,
  Stream,
  pipe,
} from "effect"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError",
)<{}> {}

const githubRepos = [
  { label: "/website", owner: "effect-ts", repo: "website" },
  { label: "/effect", owner: "effect-ts", repo: "effect" },
  { label: "/platform", owner: "effect-ts", repo: "platform" },
  { label: "/schema", owner: "effect-ts", repo: "schema" },
]
type GithubRepo = (typeof githubRepos)[number]

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI)
  const messages = yield* _(Messages)
  const registry = yield* _(InteractionsRegistry)
  const scope = yield* _(Effect.scope)
  const github = yield* _(Github)

  const createGithubIssue = github.wrap(_ => _.issues.create)

  const application = yield* _(
    Effect.flatMap(rest.getCurrentBotApplicationInformation(), _ => _.json),
  )

  const createIssue = (channel: Discord.Channel, repo: GithubRepo) =>
    pipe(
      messages.cleanForChannel(channel),
      Stream.runCollect,
      Effect.map(chunk =>
        Chunk.map(
          Chunk.reverse(chunk),
          (msg): OpenAIMessage => ({
            bot: false,
            name: msg.author.username,
            content: msg.content,
          }),
        ),
      ),
      Effect.flatMap(openAiMessages =>
        openai.generateSummary(
          channel.name!,
          Chunk.toReadonlyArray(openAiMessages),
        ),
      ),
      Effect.flatMap(summary =>
        createGithubIssue({
          owner: repo.owner,
          repo: repo.repo,
          title: `From Discord: ${channel.name}`,
          body: `# Summary
${summary}

# Discord thread

https://discord.com/channels/${channel.guild_id}/${channel.id}
`,
        }),
      ),
    )

  const followUp = (
    context: Discord.Interaction,
    channel: Discord.Channel,
    repo: GithubRepo,
  ) =>
    pipe(
      createIssue(channel, repo),
      Effect.tap(issue =>
        rest.editOriginalInteractionResponse(application.id, context.token, {
          content: `Created Github issue for thread: ${issue.html_url}`,
        }),
      ),
      Effect.tapErrorCause(() =>
        rest.deleteOriginalInteractionResponse(application.id, context.token),
      ),
      Effect.catchAllCause(Effect.logError),
    )

  const command = Ix.global(
    {
      name: "issueify",
      description:
        "Convert this thread into an issue for the Effect Website repo",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.NUMBER,
          name: "repository",
          description:
            "What repository to create the issue in. Defaults to /website",
          choices: ReadonlyArray.map(githubRepos, ({ label }, value) => ({
            name: label,
            value: value.toString(),
          })),
          required: false,
        },
      ],
    },
    ix =>
      pipe(
        Effect.all({
          context: Ix.Interaction,
          repoIndex: Effect.map(
            ix.optionValueOptional("repository"),
            Option.getOrElse(() => 0),
          ),
        }),
        Effect.let("repo", ({ repoIndex }) => githubRepos[repoIndex]!),
        Effect.bind("channel", ({ context }) =>
          channels.get(context.guild_id!, context.channel_id!),
        ),
        Effect.filterOrFail(
          ({ channel }) => channel.type === Discord.ChannelType.PUBLIC_THREAD,
          () => new NotInThreadError(),
        ),
        Effect.tap(({ context, channel, repo }) =>
          Effect.forkIn(followUp(context, channel, repo), scope),
        ),
        Effect.as(
          Ix.response({
            type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "Creating issue on Github...",
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
    .catchAllCause(Effect.logError)

  yield* _(registry.register(ix))
})

export const IssueifierLive = Layer.provide(
  Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive, MessagesLive),
  Layer.scopedDiscard(make),
)
