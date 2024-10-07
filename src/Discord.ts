import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { DiscordConfig, Intents } from "dfx"
import { DiscordIxLive } from "dfx/gateway"
import { Config, Layer } from "effect"

export const DiscordLive = DiscordIxLive.pipe(
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
