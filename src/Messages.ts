import { MemberCache, MemberCacheLive } from "bot/MemberCache"
import { Chunk, Effect, Layer, Option, Stream, Tag, pipe } from "bot/_common"
import { Discord, DiscordREST } from "dfx"

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
        Effect.forEachPar(content.matchAll(/<@(\d+)>/g), ([, userId]) =>
          Effect.option(members.get(guildId, userId as Discord.Snowflake)),
        ),
      )

      return mentions.reduce(
        (content, member) =>
          Option.match(
            member,
            () => content,
            member =>
              content.replace(
                new RegExp(`<@${member.user!.id}>`, "g"),
                `**@${member.nick ?? member.user!.username}**`,
              ),
          ),
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
          }),
          Effect.flatMap(_ => _.json),
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
      Stream.flatMapPar(Number.MAX_SAFE_INTEGER, msg => {
        if (msg.type === Discord.MessageType.THREAD_STARTER_MESSAGE) {
          return Effect.flatMap(
            rest.getChannelMessage(
              msg.message_reference!.channel_id!,
              msg.message_reference!.message_id!,
            ),
            _ => _.json,
          )
        } else if (
          msg.content !== "" &&
          (msg.type === Discord.MessageType.REPLY ||
            msg.type === Discord.MessageType.DEFAULT)
        ) {
          return Stream.succeed(msg)
        }

        return Stream.empty
      }),
    )

  const cleanForChannel = (channel: Discord.Channel) =>
    pipe(
      regularForChannel(channel.id),
      Stream.map(msg => ({
        ...msg,
        content: cleanupMarkdown(msg.content),
      })),
      Stream.flatMapPar(Number.MAX_SAFE_INTEGER, msg =>
        Effect.map(
          replaceMentions(channel.guild_id!, msg.content),
          (content): Discord.Message => ({
            ...msg,
            content,
          }),
        ),
      ),
    )

  return {
    regularForChannel,
    cleanForChannel,
    replaceMentions,
  } as const
})

export interface Messages extends Effect.Effect.Success<typeof make> {}
export const Messages = Tag<Messages>()
export const MessagesLive = Layer.provide(
  Layer.mergeAll(MemberCacheLive),
  Layer.effect(Messages, make),
)
