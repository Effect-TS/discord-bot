import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import {
  DiscordGateway,
  InteractionsRegistry,
  InteractionsRegistryLive,
} from "dfx/gateway"
import { Effect, Layer, pipe } from "effect"

const make = Effect.gen(function* (_) {
  const gateway = yield* _(DiscordGateway)
  const channels = yield* _(ChannelsCache)
  const registry = yield* _(InteractionsRegistry)

  yield* _(
    Effect.all(
      [gateway.run, channels.run, registry.run(Effect.logCause("Error"))],
      { concurrency: "unbounded", discard: true },
    ),
  )
})

export const BotLive = pipe(
  Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive),
  Layer.provide(Layer.effectDiscard(make)),
)
