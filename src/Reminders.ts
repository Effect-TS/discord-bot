import { DiscordREST } from "dfx/DiscordREST"
import { Data, Effect, Fiber, Layer, Schedule } from "effect"
import { DiscordGateway } from "dfx/gateway"
import CronParser from "cron-parser"
import { Discord } from "dfx/index"

const topicPattern = /\[reminder:(.+?):(.+?)\]/

class MissingTopic extends Data.TaggedError("MissingTopic")<{}> {}

class InvalidTopic extends Data.TaggedError("InvalidTopic")<{
  readonly reason: string
}> {}

const parseTopic = (topic: string) =>
  Effect.fromNullable(topicPattern.exec(topic)).pipe(
    Effect.mapError(() => new MissingTopic()),
    Effect.tryMap({
      try: ([, expression, message]) => {
        const cron = CronParser.parseExpression(expression.trim())
        const sleep = Effect.suspend(() => {
          const ts = cron.next().getTime()
          return Effect.sleep(ts - Date.now())
        })
        return [sleep, message] as const
      },
      catch: err => new InvalidTopic({ reason: `${err}` }),
    }),
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
        return Effect.zipRight(
          Effect.sync(() => fibers.delete(channelId)),
          Fiber.interrupt(fiber),
        )
      }
      return Effect.unit
    })

  const handleChannel = (channel: Discord.Channel) =>
    Effect.gen(function* (_) {
      yield* _(remove(channel.id))

      const [sleep, message] = yield* _(parseTopic(channel.topic ?? ""))

      yield* _(Effect.log("scheduling reminder"))

      const fiber = yield* _(
        sleep,
        Effect.zipRight(createThread(channel.id, message)),
        Effect.forever,
        Effect.ensuring(remove(channel.id)),
        Effect.catchAllCause(Effect.logError),
        Effect.forkDaemon,
      )

      fibers.set(channel.id, fiber)
    }).pipe(
      Effect.catchTags({
        MissingTopic: () => Effect.unit,
        InvalidTopic: err => Effect.logInfo(err),
      }),
      Effect.annotateLogs({
        service: "Reminders",
        channelId: channel.id,
        channelTopic: channel.topic,
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
})

export const RemindersLive = Layer.scopedDiscard(make)
