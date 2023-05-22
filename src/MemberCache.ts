import {
  Cache,
  Data,
  Duration,
  Effect,
  Layer,
  Request,
  RequestResolver,
  Tag,
  pipe,
} from "bot/_common"
import { Discord, DiscordREST } from "dfx"
import { DiscordRESTError, ResponseDecodeError } from "dfx/DiscordREST"

export class GetMember extends Data.TaggedClass("GetMember")<{
  readonly guildId: Discord.Snowflake
  readonly userId: Discord.Snowflake
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)

  interface GetMember
    extends Request.Request<
      DiscordRESTError | ResponseDecodeError,
      Discord.GuildMember
    > {
    readonly _tag: "GetMember"
    readonly guildId: Discord.Snowflake
    readonly userId: Discord.Snowflake
  }
  const GetMember = Request.tagged<GetMember>("GetMember")

  const resolver = RequestResolver.fromFunctionEffect(
    ({ guildId, userId }: GetMember) =>
      Effect.flatMap(rest.getGuildMember(guildId, userId), _ => _.json),
  )

  const cache = yield* _(Request.makeCache(1000, Duration.days(1)))

  return {
    get: (guildId: Discord.Snowflake, userId: Discord.Snowflake) =>
      pipe(
        Effect.request(GetMember({ guildId, userId }), resolver),
        Effect.withRequestCache(cache),
        Effect.withRequestCaching("on"),
      ),
  } as const
})

export interface MemberCache extends Effect.Effect.Success<typeof make> {}
export const MemberCache = Tag<MemberCache>()
export const MemberCacheLive = Layer.effect(MemberCache, make)
