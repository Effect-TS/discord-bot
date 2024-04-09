import { DiscordREST } from "dfx/DiscordREST"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Discord } from "dfx/index"
import { Cron, Data, Effect, FiberMap, Layer, Schedule } from "effect"

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
    Effect.map(cron => [cron, message] as const),
    Effect.mapError(() => new InvalidTopic({ reason: "invalid cron", match })),
  )

const createThreadPolicy = Schedule.spaced("1 seconds").pipe(
  Schedule.compose(Schedule.recurs(3)),
)

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)
  const fibers = yield* _(FiberMap.make<Discord.Snowflake>())

  const handleChannel = (channel: Discord.Channel) =>
    Effect.gen(function* (_) {
      yield* _(FiberMap.remove(fibers, channel.id))

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

      yield* _(
        Effect.forEach(
          matches,
          ([expression, message]) =>
            Effect.schedule(
              createThread(channel.id, message),
              Schedule.cron(expression),
            ),
          { discard: true, concurrency: "unbounded" },
        ),
        Effect.catchAllCause(Effect.logError),
        FiberMap.run(fibers, channel.id),
      )
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
      .json.pipe(
        Effect.flatMap(msg =>
          rest.startThreadFromMessage(msg.channel_id, msg.id, {
            name: `${new Date().toDateString()} - ${message}`,
          }),
        ),
        Effect.asUnit,
        Effect.retry(createThreadPolicy),
        Effect.withSpan("Reminders.createThread", { attributes: { message } }),
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
    gateway.handleDispatch("CHANNEL_DELETE", ({ id }) =>
      FiberMap.remove(fibers, id),
    ),
    Effect.forkScoped,
  )
}).pipe(Effect.annotateLogs({ service: "Reminders" }))

export const RemindersLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(DiscordLive),
)
