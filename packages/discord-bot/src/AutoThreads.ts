import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { Discord, DiscordREST, Ix, Perms, UI } from "dfx"
import { DiscordGateway, InteractionsRegistry } from "dfx/gateway"
import { Config, ConfigProvider, Data, Effect, Layer, Option } from "effect"
import { AiHelpers } from "./Ai.ts"
import { ChannelsCache } from "./ChannelsCache.ts"
import * as Str from "./utils/String.ts"

export class NotValidMessageError extends Data.TaggedError(
  "NotValidMessageError",
)<{
  readonly reason: "non-default" | "from-bot" | "non-text-channel" | "disabled"
}> {}

export class PermissionsError extends Data.TaggedError("PermissionsError")<{
  readonly action: string
  readonly subject: string
}> {}

const make = Effect.gen(function* () {
  const topicKeyword = yield* Config.string("keyword").pipe(
    Config.withDefault("[threads]"),
  )
  const ai = yield* AiHelpers
  const gateway = yield* DiscordGateway
  const rest = yield* DiscordREST
  const channels = yield* ChannelsCache
  const registry = yield* InteractionsRegistry

  const isEligibleChannel = (channel: Discord.GetChannel200) =>
    channel?.type === Discord.ChannelTypes.GUILD_TEXT &&
    typeof channel?.topic === "string" &&
    channel.topic.includes(topicKeyword)

  const isEligibleMessage = (event: Discord.GatewayMessageCreateDispatchData) =>
    event?.type === Discord.MessageType.DEFAULT &&
    event?.author?.bot !== true &&
    typeof event?.id === "string" &&
    typeof event?.channel_id === "string"

  const handleMessages = gateway.handleDispatch(
    "MESSAGE_CREATE",
    Effect.fnUntraced(
      function* (event) {
        if (!isEligibleMessage(event)) {
          return
        }

        const channel = yield* channels.get(event.guild_id!, event.channel_id)
        if (!isEligibleChannel(channel)) {
          return
        }

        const title = yield* ai.generateTitle(event.content).pipe(
          Effect.tapCause(Effect.log),
          Effect.withSpan("AutoThreads.generateTitle"),
          Effect.orElseSucceed(() => {
            const name = Option.getOrElse(
              Option.fromNullishOr(event.member?.nick),
              () => event.author.username,
            )
            return `${name}'s thread`
          }),
        )

        yield* Effect.annotateCurrentSpan({ title })

        const thread = yield* rest.createThreadFromMessage(
          channel.id,
          event.id,
          {
            name: Str.truncate(title, 100),
            auto_archive_duration: 1440,
          },
        )

        yield* rest.createMessage(thread.id, {
          components: UI.grid([
            [
              UI.button({
                custom_id: `edit_${event.author.id}`,
                label: "Edit title",
              }),
              UI.button({
                custom_id: `archive_${event.author.id}`,
                label: "Archive",
                style: Discord.ButtonStyleTypes.SECONDARY,
              }),
            ],
          ]),
        })
      },
      (effect, event) =>
        Effect.withSpan(effect, "AutoThreads.handleMessages", {
          attributes: {
            messageId: event.id,
          },
        }),
      Effect.catchCause(Effect.logError),
    ),
  )

  const hasManage = Perms.has(Discord.Permissions.ManageChannels)

  const withEditPermissions = Effect.fnUntraced(function* <R, E, A>(
    self: Effect.Effect<A, E, R>,
  ) {
    const ix = yield* Ix.Interaction
    const ctx = yield* Ix.MessageComponentData
    const authorId = ctx.custom_id.split("_")[1]
    const canEdit =
      authorId === ix.member?.user?.id || hasManage(ix.member!.permissions!)

    if (!canEdit) {
      return yield* new PermissionsError({
        action: "edit",
        subject: "thread",
      })
    }

    return yield* self
  })

  const edit = Ix.messageComponent(
    Ix.idStartsWith("edit_"),
    Effect.gen(function* () {
      const ix = yield* Ix.Interaction
      const channel = yield* channels.get(ix.guild_id!, ix.channel!.id)
      return Ix.response({
        type: Discord.InteractionCallbackTypes.MODAL,
        data: {
          custom_id: "edit",
          title: "Edit title",
          components: UI.singleColumn([
            UI.textInput({
              custom_id: "title",
              label: "New title",
              max_length: 100,
              value: "name" in channel ? channel.name! : "",
            }),
          ]),
        },
      })
    }).pipe(withEditPermissions, Effect.withSpan("AutoThreads.edit")),
  )

  const editSubmit = Ix.modalSubmit(
    Ix.id("edit"),
    Effect.gen(function* () {
      const context = yield* Ix.Interaction
      const title = yield* Ix.modalValue("title")
      yield* rest.updateChannel(context.channel!.id, { name: title })
      return Ix.response({
        type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
      })
    }).pipe(Effect.withSpan("AutoThreads.editSubmit")),
  )

  const archive = Ix.messageComponent(
    Ix.idStartsWith("archive_"),
    Effect.gen(function* () {
      const ix = yield* Ix.Interaction
      yield* rest.updateChannel(ix.channel!.id, { archived: true })
      return Ix.response({
        type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
      })
    }).pipe(withEditPermissions, Effect.withSpan("AutoThreads.archive")),
  )

  const ix = Ix.builder
    .add(archive)
    .add(edit)
    .add(editSubmit)
    .catchTagRespond("PermissionsError", (_) =>
      Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: Discord.MessageFlags.Ephemeral,
            content: `You don't have permission to ${_.action} this ${_.subject}.`,
          },
        }),
      ),
    )
    .catchAllCause(Effect.logError)

  yield* registry.register(ix)
  yield* Effect.forkScoped(handleMessages)
}).pipe(
  Effect.annotateLogs({ service: "AutoThreads" }),
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv().pipe(
      ConfigProvider.nested("autothreads"),
      ConfigProvider.constantCase,
    ),
  ),
)

export const AutoThreadsLive = Layer.effectDiscard(make).pipe(
  Layer.provide(ChannelsCache.layer),
  Layer.provide(AiHelpers.layer),
  Layer.provide(DiscordGatewayLayer),
)
