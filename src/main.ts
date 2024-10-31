import { NodeRuntime } from "@effect/platform-node"
import { AutoThreadsLive } from "bot/AutoThreads"
import { DadJokesLive } from "bot/DadJokes"
import { DocsLookupLive } from "bot/DocsLookup"
import { IssueifierLive } from "bot/Issueifier"
import { NoEmbedLive } from "bot/NoEmbed"
import { RemindersLive } from "bot/Reminders"
import { ReproRequesterLive } from "bot/ReproRequester"
import { Summarizer } from "bot/Summarizer"
import { TracingLive } from "bot/Tracing"
import { Config, Effect, Layer, LogLevel, Logger } from "effect"

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
  ReproRequesterLive,
  Summarizer.Default,
).pipe(Layer.provide(TracingLive), Layer.provide(LogLevelLive))

NodeRuntime.runMain(Layer.launch(MainLive))
