import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import * as Github from "bot/Github"
import { Messages, MessagesLive } from "bot/Messages"
import * as OpenAI from "bot/OpenAI"
import { Discord, DiscordREST, Ix } from "dfx"
import { DiscordIxLive, InteractionsRegistry } from "dfx/gateway"
import {
  Chunk,
  Effect,
  Data,
  Layer,
  Option,
  ReadonlyArray,
  Stream,
  pipe,
  Cause,
} from "effect"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError",
)<{}> {}

const githubRepos = [
  { label: "/website", owner: "effect-ts", repo: "website" },
  { label: "/effect", owner: "effect-ts", repo: "effect" },
]
type GithubRepo = (typeof githubRepos)[number]

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const channels = yield* _(ChannelsCache)
  const openai = yield* _(OpenAI.OpenAI)
  const messages = yield* _(Messages)
  const registry = yield* _(InteractionsRegistry)
  const scope = yield* _(Effect.scope)
  const github = yield* _(Github.Github)

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
          (msg): OpenAI.Message => ({
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
      Effect.tapErrorCause(Effect.logError),
      Effect.catchAllCause(cause =>
        rest
          .editOriginalInteractionResponse(application.id, context.token, {
            content:
              "Failed to create Github issue:\n\n```\n" +
              Cause.pretty(cause) +
              "\n```",
          })
          .pipe(
            Effect.zipLeft(Effect.sleep("1 minutes")),
            Effect.zipRight(
              rest.deleteOriginalInteractionResponse(
                application.id,
                context.token,
              ),
            ),
          ),
      ),
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
      Effect.gen(function* (_) {
        const context = yield* _(Ix.Interaction)
        const repoIndex = yield* _(
          ix.optionValueOptional("repository"),
          Effect.map(Option.getOrElse(() => 0)),
        )
        const repo = githubRepos[repoIndex]
        const channel = yield* _(
          channels.get(context.guild_id!, context.channel_id!),
        )
        if (channel.type !== Discord.ChannelType.PUBLIC_THREAD) {
          return yield* _(new NotInThreadError())
        }
        yield* _(
          followUp(context, channel, repo),
          Effect.annotateLogs("repo", repo.label),
          Effect.annotateLogs("thread", channel.id),
          Effect.forkIn(scope),
        )
        return Ix.response({
          type: Discord.InteractionCallbackType
            .DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        })
      }).pipe(Effect.annotateLogs("command", "issueify")),
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

export const IssueifierLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(DiscordIxLive),
  Layer.provide(ChannelsCacheLive),
  Layer.provide(MessagesLive),
  Layer.provide(OpenAI.layer),
  Layer.provide(Github.layer),
)
