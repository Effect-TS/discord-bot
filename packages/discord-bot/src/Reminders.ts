import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import type { Discord } from "dfx"
import { DiscordREST } from "dfx/DiscordREST"
import { DiscordGateway } from "dfx/gateway"
import { Cron, Data, Effect, FiberMap, Layer, Schedule } from "effect"

class MissingTopic extends Data.TaggedError("MissingTopic") {}

class InvalidTopic extends Data.TaggedError("InvalidTopic")<{
  readonly reason: string
  readonly match: string
}> {}

const parseTopic = (topic: string) =>
  Effect.partition(
    topic.matchAll(/\[reminder:(.+?):(.+?)\]/g),
    ([match, expression, message]) =>
      parseExpression(match, expression, message)
  )

const parseExpression = (match: string, expression: string, message: string) =>
  Cron.parse(expression.trim()).pipe(
    Effect.map((cron) => [cron, message] as const),
    Effect.mapError(() => new InvalidTopic({ reason: "invalid cron", match }))
  )

const createThreadPolicy = Schedule.spaced("1 seconds").pipe(
  Schedule.compose(Schedule.recurs(3))
)

const make = Effect.gen(function*() {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const fibers = yield* FiberMap.make<Discord.Snowflake>()

  const handleChannel = Effect.fnUntraced(
    function*(channel: Discord.GatewayChannelModifyDispatchData) {
      yield* FiberMap.remove(fibers, channel.id)

      const [errors, matches] = yield* parseTopic(channel.topic ?? "")
      yield* Effect.forEach(errors, (err) => Effect.logInfo(err))
      if (matches.length === 0) {
        return yield* new MissingTopic()
      }

      yield* Effect.log("scheduling reminders").pipe(
        Effect.annotateLogs(
          "messages",
          matches.map((_) => _[1])
        )
      )

      yield* Effect.forEach(
        matches,
        ([expression, message]) =>
          Effect.schedule(
            createThread(channel.id, message),
            Schedule.cron(expression)
          ),
        { discard: true, concurrency: "unbounded" }
      ).pipe(
        Effect.catchAllCause(Effect.logError),
        FiberMap.run(fibers, channel.id)
      )
    },
    Effect.catchTags({
      MissingTopic: () => Effect.void
    }),
    (effect, channel) =>
      Effect.annotateLogs(effect, {
        channelId: channel.id
      })
  )

  const createThread = Effect.fn("Reminders.createThread")(function*(
    channelId: Discord.Snowflake,
    message: string
  ) {
    yield* Effect.annotateCurrentSpan({ message })
    const msg = yield* rest.createMessage(channelId, {
      content: message
    })
    yield* rest.createThreadFromMessage(msg.channel_id, msg.id, {
      name: `${new Date().toDateString()} - ${message}`
    })
  }, Effect.retry(createThreadPolicy))

  yield* gateway
    .handleDispatch(
      "GUILD_CREATE",
      ({ channels }) => Effect.forEach(channels, handleChannel)
    )
    .pipe(Effect.forkScoped)
  yield* gateway
    .handleDispatch("CHANNEL_CREATE", handleChannel)
    .pipe(Effect.forkScoped)
  yield* gateway
    .handleDispatch("CHANNEL_UPDATE", handleChannel)
    .pipe(Effect.forkScoped)
  yield* gateway
    .handleDispatch("CHANNEL_DELETE", ({ id }) => FiberMap.remove(fibers, id))
    .pipe(Effect.forkScoped)
}).pipe(Effect.annotateLogs({ service: "Reminders" }))

export const RemindersLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(DiscordGatewayLayer)
)
