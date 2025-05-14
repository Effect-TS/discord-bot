import { NodeHttpClient } from "@effect/platform-node"
import { DiscordREST, DiscordRESTMemoryLive } from "dfx"
import { Effect, Layer } from "effect"
import { DiscordConfigLayer } from "./DiscordConfig.ts"

const DiscordLayer = DiscordRESTMemoryLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(DiscordConfigLayer)
)

export class DiscordApplication extends Effect.Service<DiscordApplication>()(
  "app/DiscordApplication",
  {
    effect: DiscordREST.pipe(
      Effect.flatMap((_) => _.getMyApplication()),
      Effect.orDie
    ),
    dependencies: [DiscordLayer]
  }
) {}

export const DiscordRestLayer = Layer.merge(
  DiscordLayer,
  DiscordApplication.Default
)
