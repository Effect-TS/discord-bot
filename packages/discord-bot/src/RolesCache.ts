import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Layer, Context } from "effect"

export class RolesCache extends Context.Service<RolesCache>()(
  "app/RolesCache",
  {
    make: CachePrelude.roles(Cache.memoryParentDriver()),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(DiscordGatewayLayer),
  )
}
