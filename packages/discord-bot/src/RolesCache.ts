import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Cache } from "dfx"
import { CachePrelude } from "dfx/gateway"
import { Effect } from "effect"

export class RolesCache extends Effect.Service<RolesCache>()(
  "app/RolesCache",
  {
    scoped: CachePrelude.roles(Cache.memoryParentDriver()),
    dependencies: [DiscordGatewayLayer]
  }
) {}
