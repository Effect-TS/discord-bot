import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Duration, Layer, Context } from "effect"

export class ChannelsCache extends Context.Service<ChannelsCache>()(
  "app/ChannelsCache",
  {
    make: CachePrelude.channels(
      Cache.memoryTTLParentDriver({
        ttl: Duration.minutes(30),
        strategy: "activity",
      }),
    ),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(DiscordGatewayLayer),
  )
}
