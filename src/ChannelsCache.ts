import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Context, Duration, Effect, Layer } from "effect"

const makeChannelsCache = CachePrelude.channels(
  Cache.memoryTTLParentDriver({
    ttl: Duration.minutes(30),
    strategy: "activity",
  }),
)
interface ChannelsCache
  extends Effect.Effect.Success<typeof makeChannelsCache> {}

export const ChannelsCache = Context.Tag<ChannelsCache>()
export const ChannelsCacheLive = Layer.scoped(ChannelsCache, makeChannelsCache)
