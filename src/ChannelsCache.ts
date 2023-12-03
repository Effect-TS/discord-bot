import { Cache } from "dfx"
import { CachePrelude, DiscordLive } from "dfx/gateway"
import { Context, Duration, Effect, Layer } from "effect"

const makeChannelsCache = CachePrelude.channels(
  Cache.memoryTTLParentDriver({
    ttl: Duration.minutes(30),
    strategy: "activity",
  }),
)

interface ChannelsCache {
  readonly _: unique symbol
}

export const ChannelsCache = Context.Tag<
  ChannelsCache,
  Effect.Effect.Success<typeof makeChannelsCache>
>()
export const ChannelsCacheLive = Layer.scoped(
  ChannelsCache,
  makeChannelsCache,
).pipe(Layer.provide(DiscordLive))
