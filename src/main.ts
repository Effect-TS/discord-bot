import * as AutoThreads from "bot/AutoThreads"
import { BotLive } from "bot/Bot"
import { DocsLookupLive } from "bot/DocsLookup"
import * as Github from "bot/Github"
import { IssueifierLive } from "bot/Issueifier"
import * as NoEmbed from "bot/NoEmbed"
import * as OpenAI from "bot/OpenAI"
import { SummarizerLive } from "bot/Summarizer"
import { Intents } from "dfx"
import { gatewayLayer } from "dfx/gateway"
import * as Dotenv from "dotenv"
import { Config, Effect, Layer, pipe } from "effect"

Dotenv.config()

const DiscordLive = gatewayLayer({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  debug: Config.withDefault(Config.boolean("DEBUG"), false),
  gateway: {
    intents: Config.succeed(
      Intents.fromList(["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILDS"]),
    ),
  },
})

const OpenAILive = OpenAI.makeLayer({
  apiKey: Config.secret("OPENAI_API_KEY"),
  organization: Config.option(Config.secret("OPENAI_ORGANIZATION")),
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
  urlWhitelist: Config.succeed(["effect.website"]),
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
      SummarizerLive,
      BotLive,
    ),
  ),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logError),
  Effect.runFork,
)
