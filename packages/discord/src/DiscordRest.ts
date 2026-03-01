import { NodeHttpClient } from "@effect/platform-node"
import { DiscordREST, DiscordRESTMemoryLive } from "dfx"
import { Effect, Layer, ServiceMap } from "effect"
import { DiscordConfigLayer } from "./DiscordConfig.ts"

const DiscordLayer = DiscordRESTMemoryLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(DiscordConfigLayer),
)

export class DiscordApplication extends ServiceMap.Service<DiscordApplication>()(
  "app/DiscordApplication",
  {
    make: Effect.gen(function* () {
      const rest = yield* DiscordREST
      return yield* rest.getMyApplication()
    }).pipe(Effect.orDie),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(DiscordLayer),
  )
}

export const DiscordRestLayer = Layer.merge(
  DiscordLayer,
  DiscordApplication.layer,
)
