import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Effect, Layer, pipe } from "bot/_common"
import { DiscordGateway } from "dfx/gateway"

const make = Effect.gen(function* ($) {
  const gateway = yield* $(DiscordGateway)
  const channels = yield* $(ChannelsCache)

  yield* $(Effect.allPar(gateway.run, channels.run))
})

export const BotLive = pipe(
  ChannelsCacheLive,
  Layer.provide(Layer.effectDiscard(make)),
)
