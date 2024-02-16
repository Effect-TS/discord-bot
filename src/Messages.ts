import { MemberCache } from "bot/MemberCache"
import { Discord, DiscordREST } from "dfx"
import { DiscordLive } from "dfx/gateway"
import { Chunk, Context, Effect, Layer, Option, Stream, pipe } from "effect"

export const cleanupMarkdown = (content: string) =>
  content
    .replace(/```ts\b/g, "```typescript")
    .replace(/^```/, "\n```")
    .replace(/[^\n]```/gm, "\n\n```")
    .replace(/([^\n])\n```([^\n]*\n[^\n])/gm, "$1\n\n```$2")

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const members = yield* _(MemberCache)

  const replaceMentions = (guildId: Discord.Snowflake, content: string) =>
    Effect.gen(function* (_) {
      const mentions = yield* _(
        Effect.forEach(
          content.matchAll(/<@(\d+)>/g),
          ([, userId]) =>
            Effect.option(members.get(guildId, userId as Discord.Snowflake)),
          { concurrency: "unbounded" },
        ),
      )

      return mentions.reduce(
        (content, member) =>
          Option.match(member, {
            onNone: () => content,
            onSome: member =>
              content.replace(
                new RegExp(`<@${member.user!.id}>`, "g"),
                `**@${member.nick ?? member.user!.username}**`,
              ),
          }),
        content,
      )
    })

  const regularForChannel = (channelId: string) =>
    pipe(
      Stream.paginateChunkEffect(Option.none<Discord.Snowflake>(), before =>
        pipe(
          rest.getChannelMessages(channelId, {
            limit: 100,
            before: Option.getOrUndefined(before),
          }).json,
          Effect.map(messages =>
            messages.length < 100
              ? ([
                  Chunk.unsafeFromArray(messages),
                  Option.none<Option.Option<Discord.Snowflake>>(),
                ] as const)
              : ([
                  Chunk.unsafeFromArray(messages),
                  Option.some(Option.some(messages[messages.length - 1].id)),
                ] as const),
          ),
        ),
      ),

      // only include normal messages
      Stream.flatMap(
        msg => {
          if (msg.type === Discord.MessageType.THREAD_STARTER_MESSAGE) {
            return rest.getChannelMessage(
              msg.message_reference!.channel_id!,
              msg.message_reference!.message_id!,
            ).json
          } else if (
            msg.content !== "" &&
            (msg.type === Discord.MessageType.REPLY ||
              msg.type === Discord.MessageType.DEFAULT)
          ) {
            return Stream.succeed(msg)
          }

          return Stream.empty
        },
        { concurrency: "unbounded" },
      ),
    )

  const cleanForChannel = (channel: Discord.Channel) =>
    pipe(
      regularForChannel(channel.id),
      Stream.map(msg => ({
        ...msg,
        content: cleanupMarkdown(msg.content),
      })),
      Stream.mapEffect(
        msg =>
          Effect.map(
            replaceMentions(channel.guild_id!, msg.content),
            (content): Discord.Message => ({
              ...msg,
              content,
            }),
          ),
        { concurrency: "unbounded" },
      ),
    )

  return {
    regularForChannel,
    cleanForChannel,
    replaceMentions,
  } as const
})

export class Messages extends Context.Tag("app/Messages")<
  Messages,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(this, make).pipe(
    Layer.provide(MemberCache.Live),
    Layer.provide(DiscordLive),
  )
}
