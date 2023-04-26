import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI, OpenAIError } from "bot/OpenAI"
import { Data, Effect, Layer, Option, Tag, pipe, Schedule, millis, Cause, Duration, seconds } from "bot/_common"
import { Discord, DiscordREST, Ix, Log, Perms, UI } from "dfx"
import { DiscordGateway } from "dfx/gateway"

const retryPolicy = pipe(
  Schedule.fixed(millis(500)),
  Schedule.whileInput((_: OpenAIError | Cause.NoSuchElementException) => _._tag === "OpenAIError"),
  Schedule.compose(Schedule.elapsed()),
  Schedule.whileOutput(Duration.lessThanOrEqualTo(seconds(3)))
)

// ==== errors
export class NotValidMessageError extends Data.TaggedClass(
  "NotValidMessageError",
)<{
  readonly reason: "non-default" | "from-bot" | "non-text-channel" | "disabled"
}> { }

const truncate = (str: string, len: number) =>
  str.length > len ? str.substring(0, len - 3) + "..." : str

const make = Effect.gen(function* ($) {
  const log = yield* $(Log.Log)
  const openai = yield* $(OpenAI)
  const gateway = yield* $(DiscordGateway)
  const rest = yield* $(DiscordREST)
  const channels = yield* $(ChannelsCache)

  const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", message =>
    pipe(
      Effect.allPar({
        message: Effect.cond(
          () => message.type === Discord.MessageType.DEFAULT,
          () => message,
          () => new NotValidMessageError({ reason: "non-default" }),
        ),
        channel: channels.get(message.guild_id!, message.channel_id),
      }),
      Effect.filterOrFail(
        () => message.author.bot !== true,
        () => new NotValidMessageError({ reason: "from-bot" }),
      ),
      Effect.filterOrFail(
        ({ channel }) => channel.type === Discord.ChannelType.GUILD_TEXT,
        () => new NotValidMessageError({ reason: "non-text-channel" }),
      ),
      Effect.filterOrFail(
        ({ channel }) => channel.topic?.includes("[threads]") === true,
        () => new NotValidMessageError({ reason: "disabled" }),
      ),
      Effect.bind("title", () =>
        pipe(
          Option.fromNullable(message.content),
          Option.filter(_ => _.trim().length > 0),
          Effect.flatMap(content =>
            pipe(
              openai.generateTitle(content),
              Effect.retry(retryPolicy),
              Effect.tapError(log.info)
            )
          ),
          Effect.orElseSucceed(() => `${message.member!.nick}'s thread`),
        ),
      ),
      Effect.flatMap(({ channel, title }) =>
        rest.startThreadFromMessage(channel.id, message.id, {
          name: truncate(title, 100),
        }),
      ),
      Effect.flatMap(_ => _.json),
      Effect.flatMap(thread =>
        rest.createMessage(thread.id, {
          components: UI.grid([
            [
              UI.button({
                custom_id: `edit_${message.author.id}`,
                label: "Edit title",
              }),
              UI.button({
                custom_id: `archive_${message.author.id}`,
                label: "Archive",
                style: Discord.ButtonStyle.SECONDARY,
              }),
            ],
          ]),
        }),
      ),
      Effect.catchTags({
        NotValidMessageError: () => Effect.unit(),
        DiscordRESTError: _ =>
          "response" in _.error
            ? Effect.flatMap(_.error.response.json, _ =>
              Effect.logInfo(JSON.stringify(_, null, 2)),
            )
            : log.info(_.error),
      }),
      Effect.catchAllCause(Effect.logErrorCause),
    ),
  )

  const hasManage = Perms.has(Discord.PermissionFlag.MANAGE_CHANNELS)

  const checkPermissions = <R, E, A>(
    f: (
      ix: Discord.Interaction,
      ctx: Discord.MessageComponentDatum,
    ) => Effect.Effect<R, E, A>,
  ) =>
    Effect.gen(function* ($) {
      const ix = yield* $(Ix.Interaction)
      const ctx = yield* $(Ix.MessageComponentData)
      const authorId = ctx.custom_id.split("_")[1]
      const canEdit =
        authorId === ix.member?.user?.id || hasManage(ix.member!.permissions!)

      if (!canEdit) {
        return Ix.r({
          type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: Discord.MessageFlag.EPHEMERAL,
            content: "You don't have permissions to edit this thread",
          },
        })
      }

      return yield* $(f(ix, ctx))
    })

  const edit = Ix.messageComponent(
    Ix.idStartsWith("edit_"),
    checkPermissions(() =>
      pipe(
        Ix.Interaction,
        Effect.flatMap(ix => channels.get(ix.guild_id!, ix.channel_id!)),
        Effect.map(channel =>
          Ix.r({
            type: Discord.InteractionCallbackType.MODAL,
            data: {
              custom_id: "edit",
              title: "Edit title",
              components: UI.singleColumn([
                UI.textInput({
                  custom_id: "title",
                  label: "New title",
                  value: channel.name!,
                }),
              ]),
            },
          }),
        ),
      ),
    ),
  )

  const editModal = Ix.modalSubmit(
    Ix.id("edit"),
    pipe(
      Effect.allPar({
        title: Ix.modalValue("title"),
        context: Ix.Interaction,
      }),
      Effect.flatMap(({ title, context }) =>
        rest.modifyChannel(context.channel_id!, { name: title }),
      ),
      Effect.as(
        Ix.r({ type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE }),
      ),
    ),
  )

  const archive = Ix.messageComponent(
    Ix.idStartsWith("archive_"),
    checkPermissions(ix =>
      Effect.as(
        rest.modifyChannel(ix.channel_id!, { archived: true }),
        Ix.r({ type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE }),
      ),
    ),
  )

  return {
    ix: Ix.builder.add(archive).add(edit).add(editModal),
    run: handleMessages,
  } as const
})

export interface AutoThreads extends Effect.Effect.Success<typeof make> { }
export const AutoThreads = Tag<AutoThreads>()
export const AutoThreadsLive = Layer.provide(
  ChannelsCacheLive,
  Layer.scoped(AutoThreads, make),
)
