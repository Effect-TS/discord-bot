import { TracerLayer } from "@chat/shared/Otel"
import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Logger, LogLevel, RuntimeFlags } from "effect"
import { AutoThreadsLive } from "./AutoThreads.ts"
import { DadJokesLive } from "./DadJokes.ts"
import { DocsLookupLive } from "./DocsLookup.ts"
import { IssueifierLive } from "./Issueifier.ts"
import { MentionsLive } from "./Mentions.ts"
import { NoEmbedLive } from "./NoEmbed.ts"
import { PlaygroundLive } from "./Playground.ts"
import { RemindersLive } from "./Reminders.ts"
import { ReproRequesterLive } from "./ReproRequester.ts"
import { Summarizer } from "./Summarizer.ts"

const LogLevelLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const debug = yield* Config.withDefault(Config.boolean("DEBUG"), false)
    const level = debug ? LogLevel.All : LogLevel.Info
    return Logger.minimumLogLevel(level)
  })
)

const MainLive = Layer.mergeAll(
  AutoThreadsLive,
  DadJokesLive,
  NoEmbedLive,
  DocsLookupLive,
  IssueifierLive,
  MentionsLive,
  PlaygroundLive,
  RemindersLive,
  ReproRequesterLive,
  Summarizer.Default
).pipe(
  Layer.provide(TracerLayer("discord-bot")),
  Layer.provide(LogLevelLive),
  Layer.provide(RuntimeFlags.disableRuntimeMetrics)
)

NodeRuntime.runMain(Layer.launch(MainLive))
