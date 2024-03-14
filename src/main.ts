import { AutoThreadsConfig, AutoThreadsLive } from "bot/AutoThreads"
import { DocsLookupLive } from "bot/DocsLookup"
import { GithubConfig } from "bot/Github"
import { IssueifierLive } from "bot/Issueifier"
import { NoEmbedConfig, NoEmbedLive } from "bot/NoEmbed"
import { OpenAIConfig } from "bot/OpenAI"
import { Summarizer } from "bot/Summarizer"
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
    const debug = yield* _(Config.withDefault(Config.boolean("DEBUG"), false))
    const level = debug ? LogLevel.All : LogLevel.Info
    return Logger.minimumLogLevel(level)
  }),
)

const OpenAIOptions = OpenAIConfig.layer({
  apiKey: Config.secret("OPENAI_API_KEY"),
  organization: Config.option(Config.secret("OPENAI_ORGANIZATION")),
})

const AutoThreadsOptions = AutoThreadsConfig.layer({
  topicKeyword: Config.withDefault(
    Config.string("AUTOTHREADS_KEYWORD"),
    "[threads]",
  ),
})

const NoEmbedOptions = NoEmbedConfig.layer({
  topicKeyword: Config.withDefault(
    Config.string("NOEMBED_KEYWORD"),
    "[noembed]",
  ),
  urlWhitelist: Config.succeed(["effect.website"]),
})

const GithubConfigLive = GithubConfig.layer({
  token: Config.secret("GITHUB_TOKEN"),
})

const MainLive = Layer.mergeAll(
  AutoThreadsLive,
  NoEmbedLive,
  DocsLookupLive,
  IssueifierLive,
  RemindersLive,
  Summarizer.Live,
).pipe(
  Layer.provide(DiscordConfigLive),
  Layer.provide(AutoThreadsOptions),
  Layer.provide(NoEmbedOptions),
  Layer.provide(OpenAIOptions),
  Layer.provide(GithubConfigLive),
  Layer.provide(LogLevelLive),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logError),
  Effect.runFork,
)
