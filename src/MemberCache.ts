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
        rest.getGuildMember(guildId, userId).json,
    }),
  )

  return {
    get: (guildId: Discord.Snowflake, userId: Discord.Snowflake) =>
      cache.get(new GetMember({ guildId, userId })),
  } as const
})

export class MemberCache extends Context.Tag("app/MemberCache")<
  MemberCache,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(this, make).pipe(Layer.provide(DiscordLive))
}
