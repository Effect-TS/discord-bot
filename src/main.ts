import * as AutoThreads from "bot/AutoThreads"
import { BotLive } from "bot/Bot"
import { DocsLookupLive } from "bot/DocsLookup"
import * as Github from "bot/Github"
import * as Issueifier from "bot/Issueifier"
import { MentionsLive } from "bot/Mentions"
import * as NoEmbed from "bot/NoEmbed"
import * as OpenAI from "bot/OpenAI"
import { SummarizerLive } from "bot/Summarizer"
import { Config, Effect, Layer, pipe } from "bot/_common"
import { Intents } from "dfx"
import { makeLive } from "dfx/gateway"
import * as Dotenv from "dotenv"

Dotenv.config()

const DiscordLive = makeLive({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  debug: Config.withDefault(Config.bool("DEBUG"), false),
  gateway: {
    intents: Config.succeed(
      Intents.fromList(["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILDS"]),
    ),
  },
})

const OpenAILive = OpenAI.makeLayer({
  apiKey: Config.secret("OPENAI_API_KEY"),
  organization: Config.optional(Config.secret("OPENAI_ORGANIZATION")),
})

const AutoThreadsLive = AutoThreads.makeLayer({
  topicKeyword: Config.withDefault(
    Config.string("AUTOTHREADS_KEYWORD"),
    "[threads]",
  ),
})

const NoEmbedLive = NoEmbed.makeLayer({
  topicKeyword: Config.withDefault(
    Config.string("NOEMBED_KEYWORD"),
    "[noembed]",
  ),
})

const IssueifierLive = Issueifier.makeLayer({
  githubRepo: Config.withDefault(
    Config.string("ISSUEIFIER_REPO"),
    "effect-ts/website",
  ),
})

const GithubLive = Github.makeLayer({
  token: Config.secret("GITHUB_TOKEN"),
})

const MainLive = pipe(
  Layer.mergeAll(DiscordLive, GithubLive, OpenAILive),
  Layer.provide(
    Layer.mergeAll(
      AutoThreadsLive,
      DocsLookupLive,
      IssueifierLive,
      NoEmbedLive,
      MentionsLive,
      SummarizerLive,
      BotLive,
    ),
  ),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logErrorCause),
  Effect.runFork,
)
