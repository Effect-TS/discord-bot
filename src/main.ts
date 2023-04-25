import { Config, Data, Effect, Layer, Tag, pipe } from "bot/_common"
import { Discord, DiscordREST, Intents, Ix, Perms, UI } from "dfx"
import * as Cache from "dfx/Cache"
import * as CacheP from "dfx/Cache/prelude"
import { DiscordGateway } from "dfx/DiscordGateway"
import { makeLive, runIx } from "dfx/gateway"
import { PermissionFlag } from "dfx/types"
import * as Dotenv from "dotenv"

Dotenv.config()

// ==== channels cache
const makeChannelsCache = CacheP.channels(Cache.memoryParentDriver())
interface ChannelsCache
  extends Effect.Effect.Success<typeof makeChannelsCache> {}
const ChannelsCache = Tag<ChannelsCache>()
const ChannelsCacheLive = Layer.effect(ChannelsCache, makeChannelsCache)

// ==== deps
const BotLive = makeLive({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(Intents.fromList(["GUILD_MESSAGES", "GUILDS"])),
  },
})

const EnvLive = Layer.provideMerge(BotLive, ChannelsCacheLive)

// ==== errors
class NotValidMessageError extends Data.TaggedClass("NotValidMessageError")<{
  readonly reason: "non-default" | "non-text-channel" | "disabled"
}> {}

const program = Effect.gen(function* ($) {
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
        ({ channel }) => channel.type === Discord.ChannelType.GUILD_TEXT,
        () => new NotValidMessageError({ reason: "non-text-channel" }),
      ),
      Effect.filterOrFail(
        ({ channel }) => channel.topic?.includes("[threads]") === true,
        () => new NotValidMessageError({ reason: "disabled" }),
      ),
      Effect.flatMap(({ channel }) =>
        rest.startThreadFromMessage(channel.id, message.id, {
          name: `${message.member!.nick}'s thread`,
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
      Effect.catchAllCause(Effect.logErrorCause),
    ),
  )

  const hasManage = Perms.has(PermissionFlag.MANAGE_CHANNELS)

  const checkPermissions = <R, E, A>(
    f: (
      ix: Discord.Interaction,
      ctx: Discord.MessageComponentDatum,
    ) => Effect.Effect<R, E, A>,
  ) =>
    Effect.gen(function* ($) {
      const ix = yield* $(Ix.interaction)
      const ctx = yield* $(Ix.MessageComponentContext)
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
      Effect.succeed(
        Ix.r({
          type: Discord.InteractionCallbackType.MODAL,
          data: {
            custom_id: "edit",
            title: "Edit title",
            components: UI.singleColumn([
              UI.textInput({ custom_id: "title", label: "New title" }),
            ]),
          },
        }),
      ),
    ),
  )

  const editModal = Ix.modalSubmit(
    Ix.id("edit"),
    pipe(
      Effect.allPar({
        title: Ix.modalValue("title"),
        context: Ix.interaction,
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
        rest.modifyChannel(ix.channel_id!, {
          archived: true,
        }),
        Ix.r({
          type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE,
        }),
      ),
    ),
  )

  const run = pipe(
    Ix.builder.add(archive).add(edit).add(editModal),
    runIx(Effect.catchAllCause(Effect.logErrorCause)),
  )

  yield* $(Effect.allParDiscard(handleMessages, channels.run, run))
})

pipe(
  program,
  Effect.provideLayer(EnvLive),
  Effect.tapErrorCause(Effect.logErrorCause),
  Effect.runFork,
)
