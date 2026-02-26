import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Duration, Layer, ServiceMap } from "effect"

export class ChannelsCache extends ServiceMap.Service<ChannelsCache>()(
  "app/ChannelsCache",
  {
    make: CachePrelude.channels(
      Cache.memoryTTLParentDriver({
        ttl: Duration.minutes(30),
        strategy: "activity"
      })
    )
  }
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(DiscordGatewayLayer)
  )
}
