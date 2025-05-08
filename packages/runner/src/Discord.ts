import { NodeHttpClient } from "@effect/platform-node"
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from "dfx"
import { Config, Effect, Layer } from "effect"

const DiscordLayer = DiscordRESTMemoryLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    DiscordConfig.layerConfig({
      token: Config.redacted("DISCORD_BOT_TOKEN")
    })
  )
)

export class DiscordApplication extends Effect.Service<DiscordApplication>()(
  "app/DiscordApplication",
  {
    effect: DiscordREST.pipe(
      Effect.flatMap((_) => _.getCurrentBotApplicationInformation().json),
      Effect.orDie
    ),
    dependencies: [DiscordLayer]
  }
) {}

export const DiscordLive = Layer.merge(DiscordLayer, DiscordApplication.Default)
