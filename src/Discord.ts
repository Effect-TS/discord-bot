import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { DiscordConfig, DiscordREST, Intents } from "dfx"
import { DiscordIxLive } from "dfx/gateway"
import { Config, Effect, Layer } from "effect"

const DiscordLayer = DiscordIxLive.pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(
    DiscordConfig.layerConfig({
      token: Config.redacted("DISCORD_BOT_TOKEN"),
      gateway: {
        intents: Config.succeed(
          Intents.fromList(["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILDS"]),
        ),
      },
    }),
  ),
)

export class DiscordApplication extends Effect.Service<DiscordApplication>()(
  "app/DiscordApplication",
  {
    effect: DiscordREST.pipe(
      Effect.flatMap(_ => _.getCurrentBotApplicationInformation().json),
    ),
    dependencies: [DiscordLayer],
  },
) {}

export const DiscordLive = Layer.merge(DiscordLayer, DiscordApplication.Default)
