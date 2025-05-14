import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import { DiscordIxLive } from "dfx/gateway"
import { Layer } from "effect"
import { DiscordConfigLayer } from "./DiscordConfig.ts"
import { DiscordApplication } from "./DiscordRest.ts"

const DiscordLayer = DiscordIxLive.pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(DiscordConfigLayer)
)

export const DiscordGatewayLayer = Layer.merge(
  DiscordLayer,
  DiscordApplication.Default
)
