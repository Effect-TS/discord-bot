import { DiscordLive } from "bot/Discord"
import { Discord, DiscordREST } from "dfx"
import { Cache, Data, Duration, Effect } from "effect"

export class GetMember extends Data.TaggedClass("GetMember")<{
  readonly guildId: Discord.Snowflake
  readonly userId: Discord.Snowflake
}> {}

export class MemberCache extends Effect.Service<MemberCache>()(
  "app/MemberCache",
  {
    effect: Effect.gen(function* () {
      const rest = yield* DiscordREST

      const cache = yield* Cache.make({
        capacity: 1000,
        timeToLive: Duration.days(1),
        lookup: ({ guildId, userId }: GetMember) =>
          rest.getGuildMember(guildId, userId).json,
      })

      return {
        get: (guildId: Discord.Snowflake, userId: Discord.Snowflake) =>
          cache
            .get(new GetMember({ guildId, userId }))
            .pipe(
              Effect.withSpan("MemberCache.get", { attributes: { userId } }),
            ),
      } as const
    }),
    dependencies: [DiscordLive],
  },
) {}
