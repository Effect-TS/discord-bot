import type { Discord } from "dfx"
import { DiscordREST } from "dfx"
import { Effect } from "effect"
import { DiscordLive } from "../Discord.ts"

export class DiscordThreads extends Effect.Service<DiscordThreads>()("Discord/Threads", {
  dependencies: [DiscordLive],
  effect: Effect.gen(function*() {
    const rest = yield* DiscordREST

    const historyForAi = Effect.fn("Discord/Threads.historyForAi")(function*(threadId: Discord.Snowflake) {
    })

    return { historyForAi } as const
  })
}) {}
