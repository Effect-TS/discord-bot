import { Schema, TreeFormatter } from "@effect/schema"
import { ChannelsCache } from "bot/ChannelsCache"
import { OpenAI, OpenAIError } from "bot/OpenAI"
import { LayerUtils } from "bot/_common"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST, Ix, Perms, UI } from "dfx"
import {
  DiscordGateway,
  DiscordIxLive,
  InteractionsRegistry,
} from "dfx/gateway"
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  pipe,
} from "effect"

const retryPolicy = pipe(
  Schedule.fixed(Duration.millis(500)),
  Schedule.whileInput(
    (_: OpenAIError | Cause.NoSuchElementException) => _._tag === "OpenAIError",
  ),
  Schedule.intersect(Schedule.recurs(2)),
)

export class NotValidMessageError extends Data.TaggedError(
  "NotValidMessageError",
)<{
  readonly reason: "non-default" | "from-bot" | "non-text-channel" | "disabled"
}> {}

export class PermissionsError extends Data.TaggedError("PermissionsError")<{
  readonly action: string
  readonly subject: string
}> {}

const make = ({ topicKeyword }: { readonly topicKeyword: string }) =>
  Effect.gen(function* (_) {
    const openai = yield* _(OpenAI)
    const gateway = yield* _(DiscordGateway)
    const rest = yield* _(DiscordREST)
    const channels = yield* _(ChannelsCache)
    const registry = yield* _(InteractionsRegistry)

    const EligibleChannel = Schema.struct({
      id: Schema.string,
      topic: Schema.string.pipe(Schema.includes(topicKeyword)),
      type: Schema.literal(Discord.ChannelType.GUILD_TEXT),
    }).pipe(Schema.decodeUnknown)

    const EligibleMessage = Schema.struct({
      id: Schema.string,
      channel_id: Schema.string,
      type: Schema.literal(Discord.MessageType.DEFAULT),
      author: Schema.struct({
        bot: Schema.optional(Schema.literal(false)),
      }),
    }).pipe(Schema.decodeUnknown)

    const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", message =>
      Effect.all({
        message: EligibleMessage(message),
        channel: channels
          .get(message.guild_id!, message.channel_id)
          .pipe(Effect.flatMap(EligibleChannel)),
      }).pipe(
        Effect.bind("title", () =>
          pipe(
            Str.nonEmpty(message.content),
            Effect.flatMap(content =>
              pipe(
                openai.generateTitle(content),
                Effect.retry(retryPolicy),
                Effect.tapErrorCause(_ => Effect.log(_)),
              ),
            ),
            Effect.orElseSucceed(() =>
              pipe(
                Option.fromNullable(message.member?.nick),
                Option.getOrElse(() => message.author.username),
                _ => `${_}'s thread`,
              ),
            ),
          ),
        ),
        Effect.flatMap(
          ({ channel, title }) =>
            rest.startThreadFromMessage(channel.id, message.id, {
              name: Str.truncate(title, 100),
              auto_archive_duration: 1440,
            }).json,
        ),
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
          ParseError: error =>
            Effect.logDebug(TreeFormatter.formatIssue(error.error)),
        }),
        Effect.catchAllCause(Effect.logError),
      ),
    )

    const hasManage = Perms.has(Discord.PermissionFlag.MANAGE_CHANNELS)

    const withEditPermissions = <R, E, A>(self: Effect.Effect<A, E, R>) =>
      Effect.gen(function* ($) {
        const ix = yield* $(Ix.Interaction)
        const ctx = yield* $(Ix.MessageComponentData)
        const authorId = ctx.custom_id.split("_")[1]
        const canEdit =
          authorId === ix.member?.user?.id || hasManage(ix.member!.permissions!)

        if (!canEdit) {
          yield* _(new PermissionsError({ action: "edit", subject: "thread" }))
        }

        return yield* $(self)
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
      ),
    )

    const archive = Ix.messageComponent(
      Ix.idStartsWith("archive_"),
      pipe(
        Ix.Interaction,
        Effect.tap(ix =>
          rest.modifyChannel(ix.channel_id!, { archived: true }),
        ),
        Effect.as(
          Ix.response({
            type: Discord.InteractionCallbackType.DEFERRED_UPDATE_MESSAGE,
          }),
        ),
        withEditPermissions,
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

    yield* _(registry.register(ix))
    yield* _(handleMessages, Effect.forkScoped)
  }).pipe(Effect.annotateLogs({ service: "AutoThreads" }))

export class AutoThreadsConfig extends Context.Tag("app/AutoThreadsConfig")<
  AutoThreadsConfig,
  Parameters<typeof make>[0]
>() {
  static layer = LayerUtils.config(AutoThreadsConfig)
}

export const AutoThreadsLive = Layer.scopedDiscard(
  Effect.flatMap(AutoThreadsConfig, make),
).pipe(
  Layer.provide(ChannelsCache.Live),
  Layer.provide(OpenAI.Live),
  Layer.provide(DiscordIxLive),
)
