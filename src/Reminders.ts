import { DiscordREST } from "dfx/DiscordREST"
import { Cron, Data, Effect, Fiber, Layer, Schedule } from "effect"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Discord } from "dfx/index"

class MissingTopic extends Data.TaggedError("MissingTopic")<{}> {}

class InvalidTopic extends Data.TaggedError("InvalidTopic")<{
  readonly reason: string
  readonly match: string
}> {}

const parseTopic = (topic: string) =>
  Effect.partition(
    topic.matchAll(/\[reminder:(.+?):(.+?)\]/g),
    ([match, expression, message]) =>
      parseExpression(match, expression, message),
  )

const parseExpression = (match: string, expression: string, message: string) =>
  Cron.parse(expression.trim()).pipe(
    Effect.as([expression.trim(), message] as const),
    Effect.mapError(() => new InvalidTopic({ reason: "invalid cron", match })),
  )

const createThreadPolicy = Schedule.spaced("1 seconds").pipe(
  Schedule.compose(Schedule.recurs(3)),
)

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)

  const fibers = new Map<Discord.Snowflake, Fiber.RuntimeFiber<never, void>>()
  yield* _(
    Effect.addFinalizer(() =>
      Effect.forEach(fibers.values(), Fiber.interrupt, { discard: true }).pipe(
        Effect.tap(() => fibers.clear()),
      ),
    ),
  )

  const remove = (channelId: Discord.Snowflake) =>
    Effect.suspend(() => {
      const fiber = fibers.get(channelId)
      if (fiber) {
        fibers.delete(channelId)
        return Fiber.interrupt(fiber)
      }
      return Effect.unit
    })

  const handleChannel = (channel: Discord.Channel) =>
    Effect.gen(function* (_) {
      yield* _(remove(channel.id))

      const [errors, matches] = yield* _(parseTopic(channel.topic ?? ""))
      yield* _(Effect.forEach(errors, err => Effect.logInfo(err)))
      if (matches.length === 0) {
        return yield* _(new MissingTopic())
      }

      yield* _(
        Effect.log("scheduling reminders"),
        Effect.annotateLogs(
          "messages",
          matches.map(_ => _[1]),
        ),
      )

      const fiber = yield* _(
        Effect.forEach(
          matches,
          ([expression, message]) =>
            Effect.schedule(
              createThread(channel.id, message),
              Schedule.cron(expression),
            ),
          { discard: true, concurrency: "unbounded" },
        ),
        Effect.ensuring(remove(channel.id)),
        Effect.catchAllCause(Effect.logError),
        Effect.forkDaemon,
      )

      fibers.set(channel.id, fiber)
    }).pipe(
      Effect.catchTags({
        MissingTopic: () => Effect.unit,
      }),
      Effect.annotateLogs({
        channelId: channel.id,
      }),
    )

  const createThread = (channelId: Discord.Snowflake, message: string) =>
    rest
      .createMessage(channelId, {
        content: message,
      })
      .pipe(
        Effect.flatMap(_ => _.json),
        Effect.flatMap(msg =>
          rest.startThreadFromMessage(msg.channel_id, msg.id, {
            name: `${new Date().toDateString()} - ${message}`,
          }),
        ),
        Effect.asUnit,
        Effect.retry(createThreadPolicy),
      )

  yield* _(
    gateway.handleDispatch("GUILD_CREATE", ({ channels }) =>
      Effect.forEach(channels, handleChannel),
    ),
    Effect.forkScoped,
  )
  yield* _(
    gateway.handleDispatch("CHANNEL_CREATE", handleChannel),
    Effect.forkScoped,
  )
  yield* _(
    gateway.handleDispatch("CHANNEL_UPDATE", handleChannel),
    Effect.forkScoped,
  )
  yield* _(
    gateway.handleDispatch("CHANNEL_DELETE", ({ id }) => remove(id)),
    Effect.forkScoped,
  )
}).pipe(Effect.annotateLogs({ service: "Reminders" }))

export const RemindersLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(DiscordLive),
)
