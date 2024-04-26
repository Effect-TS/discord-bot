import { AutoThreadsLive } from "bot/AutoThreads"
import { DocsLookupLive } from "bot/DocsLookup"
import { IssueifierLive } from "bot/Issueifier"
import { NoEmbedLive } from "bot/NoEmbed"
import { Summarizer } from "bot/Summarizer"
import { DiscordConfig, Intents } from "dfx"
import * as Dotenv from "dotenv"
import {
  Config,
  ConfigError,
  ConfigProvider,
  Effect,
  Layer,
  LogLevel,
  Logger,
  pipe,
} from "effect"
import { RemindersLive } from "./Reminders.js"
import { NodeHttpClient } from "@effect/platform-node"
import { TracingLive } from "bot/Tracing"

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
  Effect.gen(function* () {
    const debug = yield* Config.withDefault(Config.boolean("DEBUG"), false)
    const level = debug ? LogLevel.All : LogLevel.Info
    return Logger.minimumLogLevel(level)
  }),
)

const MainLive = Layer.mergeAll(
  AutoThreadsLive,
  NoEmbedLive,
  DocsLookupLive,
  IssueifierLive,
  RemindersLive,
  Summarizer.Live,
).pipe(
  Layer.provide(DiscordConfigLive),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(TracingLive),
  Layer.provide(LogLevelLive),
  Layer.provide(Logger.logFmt),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logError),
  Effect.runFork,
)
