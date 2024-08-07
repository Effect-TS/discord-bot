import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { DiscordIxLive } from "dfx/gateway"
import { DiscordConfig, Intents } from "dfx"
import { Config, Layer } from "effect"

export const DiscordLive = DiscordIxLive.pipe(
  Layer.provideMerge(
    NodeHttpClient.layerUndiciWithoutDispatcher.pipe(
      Layer.provide(NodeHttpClient.dispatcherLayer),
    ),
  ),
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
