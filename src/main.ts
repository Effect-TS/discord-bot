import * as AutoThreads from "bot/AutoThreads"
import { DocsLookupLive } from "bot/DocsLookup"
import * as Github from "bot/Github"
import { IssueifierLive } from "bot/Issueifier"
import * as NoEmbed from "bot/NoEmbed"
import * as OpenAI from "bot/OpenAI"
import { SummarizerLive } from "bot/Summarizer"
import { DiscordConfig, Intents } from "dfx"
import * as Dotenv from "dotenv"
import { Config, Effect, Layer, LogLevel, Logger, pipe } from "effect"
import { RemindersLive } from "./Reminders.js"

Dotenv.config()

const DiscordConfigLive = DiscordConfig.layerConfig({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(
      Intents.fromList(["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILDS"]),
    ),
  },
})

const LogLevelLive = Layer.unwrapEffect(
  Effect.gen(function* (_) {
    const debug = yield* _(
      Effect.config(Config.withDefault(Config.boolean("DEBUG"), false)),
    )
    const level = debug ? LogLevel.All : LogLevel.Info
    return Logger.minimumLogLevel(level)
  }),
)

const OpenAIOptions = OpenAI.layerConfig({
  apiKey: Config.secret("OPENAI_API_KEY"),
  organization: Config.option(Config.secret("OPENAI_ORGANIZATION")),
})

const AutoThreadsOptions = AutoThreads.layerConfig({
  topicKeyword: Config.withDefault(
    Config.string("AUTOTHREADS_KEYWORD"),
    "[threads]",
  ),
})

const NoEmbedOptions = NoEmbed.layerConfig({
  topicKeyword: Config.withDefault(
    Config.string("NOEMBED_KEYWORD"),
    "[noembed]",
  ),
  urlWhitelist: Config.succeed(["effect.website"]),
})

const GithubConfig = Github.layerConfig({
  token: Config.secret("GITHUB_TOKEN"),
})

const MainLive = Layer.mergeAll(
  AutoThreads.layer,
  NoEmbed.layer,
  DocsLookupLive,
  IssueifierLive,
  RemindersLive,
  SummarizerLive,
).pipe(
  Layer.provide(DiscordConfigLive),
  Layer.provide(AutoThreadsOptions),
  Layer.provide(NoEmbedOptions),
  Layer.provide(OpenAIOptions),
  Layer.provide(GithubConfig),
  Layer.provide(LogLevelLive),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logError),
  Effect.runFork,
)
