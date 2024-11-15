import { ChannelsCache } from "bot/ChannelsCache"
import { DiscordLive } from "bot/Discord"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST, Ix, Perms, UI } from "dfx"
import { DiscordGateway, InteractionsRegistry } from "dfx/gateway"
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
  pipe,
} from "effect"
import { AiHelpers } from "./Ai.js"

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

  const EligibleChannel = Schema.Struct({
    id: Schema.String,
    topic: Schema.String.pipe(Schema.includes(topicKeyword)),
    type: Schema.Literal(Discord.ChannelType.GUILD_TEXT),
  })
    .annotations({ identifier: "EligibleChannel" })
    .pipe(Schema.decodeUnknown)

  const EligibleMessage = Schema.Struct({
    id: Schema.String,
    channel_id: Schema.String,
    type: Schema.Literal(Discord.MessageType.DEFAULT),
    author: Schema.Struct({
      bot: Schema.optional(Schema.Literal(false)),
    }),
  })
    .annotations({ identifier: "EligibleMessage" })
    .pipe(Schema.decodeUnknown)

  const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", event =>
    Effect.gen(function* () {
      const message = yield* EligibleMessage(event)
      const channel = yield* channels
        .get(event.guild_id!, event.channel_id)
        .pipe(Effect.flatMap(EligibleChannel))

      const title = yield* ai.generateTitle(event.content).pipe(
        Effect.tapErrorCause(Effect.log),
        Effect.withSpan("AutoThreads.generateTitle"),
        Effect.orElseSucceed(() =>
          pipe(
            Option.fromNullable(event.member?.nick),
            Option.getOrElse(() => event.author.username),
            name => `${name}'s thread`,
          ),
        ),
      )

      yield* Effect.annotateCurrentSpan({ title })

      const thread = yield* rest.startThreadFromMessage(
        channel.id,
        message.id,
        {
          name: Str.truncate(title, 100),
          auto_archive_duration: 1440,
        },
      ).json

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
              style: Discord.ButtonStyle.SECONDARY,
            }),
          ],
        ]),
      })
    }).pipe(
      Effect.withSpan("AutoThreads.handleMessages"),
      Effect.catchTag("ParseError", Effect.logDebug),
      Effect.catchAllCause(Effect.logError),
    ),
  )

  const hasManage = Perms.has(Discord.PermissionFlag.MANAGE_CHANNELS)

  const withEditPermissions = <R, E, A>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
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
    pipe(
      Ix.Interaction,
      Effect.flatMap(ix => channels.get(ix.guild_id!, ix.channel_id!)),
      Effect.map(channel =>
        Ix.response({
          type: Discord.InteractionCallbackType.MODAL,
          data: {
            custom_id: "edit",
            title: "Edit title",
            components: UI.singleColumn([
              UI.textInput({
                custom_id: "title",
                label: "New title",
                max_length: 100,
                value: channel.name!,
              }),
            ]),
          },
        }),
      ),
      withEditPermissions,
      Effect.withSpan("AutoThreads.edit"),
    ),
  )

  const editSubmit = Ix.modalSubmit(
    Ix.id("edit"),
    Effect.all(
      {
        title: Ix.modalValue("title"),
        context: Ix.Interaction,
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.tap(({ title, context }) =>
        rest.modifyChannel(context.channel_id!, { name: title }),
      ),
      Effect.as(
        Ix.response({
          type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE,
        }),
      ),
      Effect.withSpan("AutoThreads.editSubmit"),
    ),
  )

  const archive = Ix.messageComponent(
    Ix.idStartsWith("archive_"),
    pipe(
      Ix.Interaction,
      Effect.tap(ix => rest.modifyChannel(ix.channel_id!, { archived: true })),
      Effect.as(
        Ix.response({
          type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE,
        }),
      ),
      withEditPermissions,
      Effect.withSpan("AutoThreads.archive"),
    ),
  )

  const ix = Ix.builder
    .add(archive)
    .add(edit)
    .add(editSubmit)
    .catchTagRespond("PermissionsError", _ =>
      Effect.succeed(
        Ix.response({
          type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: Discord.MessageFlag.EPHEMERAL,
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
  Effect.withConfigProvider(
    ConfigProvider.fromEnv().pipe(
      ConfigProvider.nested("autothreads"),
      ConfigProvider.constantCase,
    ),
  ),
)

export const AutoThreadsLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(ChannelsCache.Default),
  Layer.provide(AiHelpers.Default),
  Layer.provide(DiscordLive),
)
