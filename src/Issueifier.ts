import { AiInput, AiRole } from "@effect/ai"
import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordApplication, DiscordLive } from "bot/Discord"
import { Github } from "bot/Github"
import { Messages } from "bot/Messages"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import {
  Array,
  Cause,
  Chunk,
  Data,
  Effect,
  FiberMap,
  Layer,
  Stream,
  pipe,
} from "effect"
import { AiHelpers } from "./Ai.js"

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError",
)<{}> {}

const githubRepos = [
  { label: "/effect", owner: "effect-ts", repo: "effect" },
  { label: "/website", owner: "effect-ts", repo: "website" },
]
type GithubRepo = (typeof githubRepos)[number]

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache
  const ai = yield* AiHelpers
  const messages = yield* Messages
  const registry = yield* InteractionsRegistry
  const github = yield* Github
  const fiberMap = yield* FiberMap.make<Discord.Snowflake>()

  const createGithubIssue = github.wrap(_ => _.issues.create)

  const application = yield* DiscordApplication

  const createIssue = Effect.fn("Issueifier.createIssue")(function* (
    channel: Discord.Channel,
    repo: GithubRepo,
  ) {
    const chunk = yield* Stream.runCollect(messages.cleanForChannel(channel))
    const input = chunk.pipe(
      Chunk.reverse,
      Chunk.map(
        (msg): AiInput.Message =>
          AiInput.Message.fromInput(
            msg.content,
            AiRole.userWithName(msg.author.username),
          ),
      ),
    )
    const summary = yield* ai.generateSummary(channel.name!, input)
    return yield* createGithubIssue({
      owner: repo.owner,
      repo: repo.repo,
      title: `From Discord: ${channel.name}`,
      body: `# Summary
${summary}

# Discord thread

https://discord.com/channels/${channel.guild_id}/${channel.id}
`,
    })
  })

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
      Effect.withSpan("Issueifier.followUp"),
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
          description: "What repository to create the issue in.",
          choices: Array.map(githubRepos, ({ label }, value) => ({
            name: label,
            value: value.toString(),
          })),
          required: true,
        },
      ],
    },
    Effect.fn("Issueifier.command")(
      function* (ix) {
        const context = yield* Ix.Interaction
        const repoIndex = ix.optionValue("repository")
        const repo = githubRepos[repoIndex]
        yield* Effect.annotateCurrentSpan({ repo: repo.label })
        const channel = yield* channels.get(
          context.guild_id!,
          context.channel_id!,
        )
        if (channel.type !== Discord.ChannelType.PUBLIC_THREAD) {
          return yield* new NotInThreadError()
        }
        yield* followUp(context, channel, repo).pipe(
          Effect.annotateLogs("repo", repo.label),
          Effect.annotateLogs("thread", channel.id),
          FiberMap.run(fiberMap, context.id),
        )
        return Ix.response({
          type: Discord.InteractionCallbackType
            .DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        })
      },
      Effect.annotateLogs("command", "issueify"),
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
})

export const IssueifierLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(AiHelpers.Default),
  Layer.provide(ChannelsCache.Default),
  Layer.provide(DiscordLive),
  Layer.provide(Messages.Default),
  Layer.provide(Github.Default),
)
