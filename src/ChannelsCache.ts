import { Duration, Effect, Layer, Tag } from "bot/_common"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"

const makeChannelsCache = CachePrelude.channels(
  Cache.memoryTTLParentDriver({
    ttl: Duration.minutes(30),
    strategy: "activity",
  }),
)
interface ChannelsCache
  extends Effect.Effect.Success<typeof makeChannelsCache> {}

export const ChannelsCache = Tag<ChannelsCache>()
export const ChannelsCacheLive = Layer.scoped(ChannelsCache, makeChannelsCache)
