import { ChannelsCache, ChannelsCacheLive } from "bot/ChannelsCache"
import { OpenAI, OpenAIError } from "bot/OpenAI"
import * as Str from "bot/utils/String"
import { Discord, DiscordREST, Ix, Log, Perms, UI } from "dfx"
import {
  DiscordGateway,
  InteractionsRegistry,
  InteractionsRegistryLive,
} from "dfx/gateway"
import {
  Cause,
  Config,
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
  Schedule.compose(Schedule.elapsed),
  Schedule.whileOutput(Duration.lessThanOrEqualTo(Duration.seconds(3))),
)

export class NotValidMessageError extends Data.TaggedClass(
  "NotValidMessageError",
)<{
  readonly reason: "non-default" | "from-bot" | "non-text-channel" | "disabled"
}> {}

export class PermissionsError extends Data.TaggedClass("PermissionsError")<{
  readonly action: string
  readonly subject: string
}> {}

export interface AutoThreadsOptions {
  readonly topicKeyword: string
}

const make = ({ topicKeyword }: AutoThreadsOptions) =>
  Effect.gen(function* (_) {
    const log = yield* _(Log.Log)
    const openai = yield* _(OpenAI)
    const gateway = yield* _(DiscordGateway)
    const rest = yield* _(DiscordREST)
    const channels = yield* _(ChannelsCache)
    const registry = yield* _(InteractionsRegistry)

    const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", message =>
      Effect.all(
        {
          message: Effect.if(message.type === Discord.MessageType.DEFAULT, {
            onTrue: Effect.succeed(message),
            onFalse: Effect.fail(
              new NotValidMessageError({ reason: "non-default" }),
            ),
          }),
          channel: channels.get(message.guild_id!, message.channel_id),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.filterOrFail(
          () => message.author.bot !== true,
          () => new NotValidMessageError({ reason: "from-bot" }),
        ),
        Effect.filterOrFail(
          ({ channel }) => channel.type === Discord.ChannelType.GUILD_TEXT,
          () => new NotValidMessageError({ reason: "non-text-channel" }),
        ),
        Effect.filterOrFail(
          ({ channel }) => channel.topic?.includes(topicKeyword) === true,
          () => new NotValidMessageError({ reason: "disabled" }),
        ),
        Effect.bind("title", () =>
          pipe(
            Str.nonEmpty(message.content),
            Effect.flatMap(content =>
              pipe(
                openai.generateTitle(content),
                Effect.retry(retryPolicy),
                Effect.tapError(_ => log.info(_)),
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
        Effect.flatMap(({ channel, title }) =>
          rest.startThreadFromMessage(channel.id, message.id, {
            name: Str.truncate(title, 100),
            auto_archive_duration: 1440,
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
          NotValidMessageError: () => Effect.unit,
        }),
        Effect.catchAllCause(Effect.logCause("Error")),
      ),
    )

    const hasManage = Perms.has(Discord.PermissionFlag.MANAGE_CHANNELS)

    const withEditPermissions = <R, E, A>(self: Effect.Effect<R, E, A>) =>
      Effect.gen(function* ($) {
        const ix = yield* $(Ix.Interaction)
        const ctx = yield* $(Ix.MessageComponentData)
        const authorId = ctx.custom_id.split("_")[1]
        const canEdit =
          authorId === ix.member?.user?.id || hasManage(ix.member!.permissions!)

        if (!canEdit) {
          yield* _(
            Effect.fail(
              new PermissionsError({ action: "edit", subject: "thread" }),
            ),
          )
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
      .catchAllCause(Effect.logCause("Error"))

    yield* _(registry.register(ix))
    yield* _(handleMessages)
  })

export const makeLayer = (config: Config.Config.Wrap<AutoThreadsOptions>) =>
  Layer.provide(
    Layer.mergeAll(ChannelsCacheLive, InteractionsRegistryLive),
    Layer.effectDiscard(
      Effect.flatMap(Effect.config(Config.unwrap(config)), make),
    ),
  )
