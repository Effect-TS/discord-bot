import { TracerLayer } from "@chat/shared/Otel"
import { NodeRuntime } from "@effect/platform-node"
import { Config, Layer, References } from "effect"
import { AiResponse } from "./AiResponse.ts"
import { AutoThreadsLive } from "./AutoThreads.ts"
import { DadJokesLive } from "./DadJokes.ts"
import { DocsLookupLive } from "./DocsLookup.ts"
import { IssueifierLive } from "./Issueifier.ts"
import { NoEmbedLive } from "./NoEmbed.ts"
import { NotificationsLayer } from "./Notifications.ts"
import { PlaygroundLive } from "./Playground.ts"
import { RemindersLive } from "./Reminders.ts"
import { ReproRequesterLive } from "./ReproRequester.ts"
import { Summarizer } from "./Summarizer.ts"

const LogLevelLive = Layer.effect(
  References.MinimumLogLevel,
  Config.withDefault(Config.boolean("DEBUG"), false).pipe(
    Config.map((debug) => (debug ? "All" : "Info"))
  ).asEffect()
)

const MainLive = Layer.mergeAll(
  AiResponse,
  AutoThreadsLive,
  DadJokesLive,
  NoEmbedLive,
  DocsLookupLive,
  IssueifierLive,
  NotificationsLayer,
  PlaygroundLive,
  RemindersLive,
  ReproRequesterLive,
  Summarizer.layer
).pipe(Layer.provide(TracerLayer("discord-bot")), Layer.provide(LogLevelLive))

NodeRuntime.runMain(Layer.launch(MainLive))
