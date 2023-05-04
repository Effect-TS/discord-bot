import { AutoThreads } from "bot/AutoThreads"
import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Effect, Layer, pipe } from "bot/_common"
import { Ix } from "dfx"
import { DiscordGateway, runIx } from "dfx/gateway"

const make = Effect.gen(function* (_) {
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const autoThreads = yield* _(AutoThreads)

  const runInteractions = pipe(
    Ix.builder.concat(autoThreads.ix),
    runIx(Effect.catchAllCause(Effect.logErrorCause)),
  )

  yield* _(
    Effect.allPar(gateway.run, channels.run, autoThreads.run, runInteractions),
  )
})

export const BotLive = pipe(
  ChannelsCacheLive,
  Layer.provide(Layer.effectDiscard(make)),
)
