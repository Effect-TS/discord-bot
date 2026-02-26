import type { Discord } from "dfx"
import { DiscordREST } from "dfx"
import { Cache, Data, Duration, Effect, Layer, ServiceMap } from "effect"
import { DiscordRestLayer } from "./DiscordRest.ts"

export class GetMember extends Data.TaggedClass("GetMember")<{
  readonly guildId: Discord.Snowflake
  readonly userId: Discord.Snowflake
}> {}

export class MemberCache extends ServiceMap.Service<MemberCache>()(
  "discord/MemberCache",
  {
    make: Effect.gen(function*() {
      const rest = yield* DiscordREST

      const cache = yield* Cache.make({
        capacity: 1000,
        timeToLive: Duration.days(1),
        lookup: ({ guildId, userId }: GetMember) =>
          rest.getGuildMember(guildId, userId)
      })

      return {
        get: (guildId: Discord.Snowflake, userId: Discord.Snowflake) =>
          Cache.get(cache, new GetMember({ guildId, userId })).pipe(
            Effect.withSpan("MemberCache.get", { attributes: { userId } })
          )
      } as const
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(DiscordRestLayer)
  )
}
