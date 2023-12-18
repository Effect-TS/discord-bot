import { Discord, DiscordREST } from "dfx"
import { DiscordLive } from "dfx/gateway"
import { Cache, Context, Data, Duration, Effect, Layer } from "effect"

export class GetMember extends Data.TaggedClass("GetMember")<{
  readonly guildId: Discord.Snowflake
  readonly userId: Discord.Snowflake
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)

  const cache = yield* _(
    Cache.make({
      capacity: 1000,
      timeToLive: Duration.days(1),
      lookup: ({ guildId, userId }: GetMember) =>
        Effect.flatMap(rest.getGuildMember(guildId, userId), _ => _.json),
    }),
  )

  return {
    get: (guildId: Discord.Snowflake, userId: Discord.Snowflake) =>
      cache.get(new GetMember({ guildId, userId })),
  } as const
})

export interface MemberCache {
  readonly _: unique symbol
}
export const MemberCache = Context.Tag<
  MemberCache,
  Effect.Effect.Success<typeof make>
>("app/MemberCache")
export const MemberCacheLive = Layer.effect(MemberCache, make).pipe(
  Layer.provide(DiscordLive),
)
