import { AutoThreadsLive } from "bot/AutoThreads"
import { DocsLookupLive } from "bot/DocsLookup"
import { IssueifierLive } from "bot/Issueifier"
import { NoEmbedLive } from "bot/NoEmbed"
import { Summarizer } from "bot/Summarizer"
import { TracingLive } from "bot/Tracing"
import * as Dotenv from "dotenv"
import { Config, Effect, Layer, LogLevel, Logger, pipe } from "effect"
import { RemindersLive } from "./Reminders.js"
import { DadJokesLive } from "./DadJokes.js"

Dotenv.config()

const LogLevelLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const debug = yield* Config.withDefault(Config.boolean("DEBUG"), false)
    const level = debug ? LogLevel.All : LogLevel.Info
    return Logger.minimumLogLevel(level)
  }),
)

const MainLive = Layer.mergeAll(
  AutoThreadsLive,
  DadJokesLive,
  NoEmbedLive,
  DocsLookupLive,
  IssueifierLive,
  RemindersLive,
  Summarizer.Live,
).pipe(
  Layer.provide(TracingLive),
  Layer.provide(LogLevelLive),
  Layer.provide(Logger.pretty),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logError),
  Effect.runFork,
)
