import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { Effect, Layer, pipe } from "bot/_common"
import {
  DiscordGateway,
  InteractionsRegistry,
  InteractionsRegistryLive,
} from "dfx/gateway"

const make = Effect.gen(function* (_) {
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const registry = yield* _(InteractionsRegistry)

  yield* _(
    Effect.all(
      gateway.run,
      channels.run,
      registry.run(Effect.logCause({ level: "Error" })),
      { concurrency: "unbounded", discard: true },
    ),
  )
})

export const BotLive = pipe(
  Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive),
  Layer.provide(Layer.effectDiscard(make)),
)
