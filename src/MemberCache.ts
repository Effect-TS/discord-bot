import { Cache, Data, Duration, Effect, Layer, Tag } from "bot/_common"
import { Discord, DiscordREST } from "dfx"

export class GetMember extends Data.TaggedClass("GetMember")<{
  readonly guildId: Discord.Snowflake
  readonly userId: Discord.Snowflake
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)

  class GetMember extends Data.TaggedClass("GetMember")<{
    readonly guildId: Discord.Snowflake
    readonly userId: Discord.Snowflake
  }> {}

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

export interface MemberCache extends Effect.Effect.Success<typeof make> {}
export const MemberCache = Tag<MemberCache>()
export const MemberCacheLive = Layer.effect(MemberCache, make)
