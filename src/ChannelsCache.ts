import { DiscordLive } from "bot/Discord"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Context, Duration, Effect, Layer } from "effect"

const makeChannelsCache = CachePrelude.channels(
  Cache.memoryTTLParentDriver({
    ttl: Duration.minutes(30),
    strategy: "activity",
  }),
)

export class ChannelsCache extends Context.Tag("app/ChannelsCache")<
  ChannelsCache,
  Effect.Effect.Success<typeof makeChannelsCache>
>() {
  static Live = Layer.scoped(this, makeChannelsCache).pipe(
    Layer.provide(DiscordLive),
  )
}
