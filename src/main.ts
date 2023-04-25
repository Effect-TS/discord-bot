import { AutoThreads, AutoThreadsLive } from "bot/AutoThreads"
import { Config, Effect, Layer, pipe } from "bot/_common"
import { Intents, Ix } from "dfx"
import { makeLive, runIx } from "dfx/gateway"
import * as Dotenv from "dotenv"

Dotenv.config()

const program = Effect.gen(function* ($) {
  const autoThreads = yield* $(AutoThreads)

  const runInteractions = pipe(
    Ix.builder.concat(autoThreads.ix),
    runIx(Effect.catchAllCause(Effect.logErrorCause)),
  )

  yield* $(runInteractions)
})

const BotLive = makeLive({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(Intents.fromList(["GUILD_MESSAGES", "GUILDS"])),
  },
})

const EnvLive = Layer.provideMerge(BotLive, AutoThreadsLive)

pipe(
  program,
  Effect.provideLayer(EnvLive),
  Effect.tapErrorCause(Effect.logErrorCause),
  Effect.runFork,
)
