import { AutoThreads, AutoThreadsLive } from "bot/AutoThreads"
import { Config, Effect, Layer, pipe } from "bot/_common"
import { Intents, Ix } from "dfx"
import { DiscordGateway, makeLive, runIx } from "dfx/gateway"
import * as Dotenv from "dotenv"
import { ChannelsCache, ChannelsCacheLive } from "./ChannelsCache.js"

Dotenv.config()

const program = Effect.gen(function* ($) {
  const gateway = yield* $(DiscordGateway)
  const channels = yield* $(ChannelsCache)
  const autoThreads = yield* $(AutoThreads)

  const runInteractions = pipe(
    Ix.builder.concat(autoThreads.ix),
    runIx(Effect.catchAllCause(Effect.logErrorCause)),
  )

  yield* $(
    Effect.allParDiscard(
      gateway.run,
      channels.run,
      autoThreads.run,
      runInteractions,
    ),
  )
})

const BotLive = makeLive({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(Intents.fromList(["GUILD_MESSAGES", "GUILDS"])),
  },
})

const EnvLive = Layer.provideMerge(
  BotLive,
  Layer.merge(AutoThreadsLive, ChannelsCacheLive),
)

pipe(
  program,
  Effect.provideLayer(EnvLive),
  Effect.tapErrorCause(Effect.logErrorCause),
  Effect.runFork,
)
