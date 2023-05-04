import { Data, Effect, Layer, pipe } from "bot/_common"
import { DiscordREST } from "dfx"
import { DiscordGateway } from "dfx/DiscordGateway"

class NonEligibleMessage extends Data.TaggedClass("NonEligibleMessage")<{
  readonly reason: "non-mentioned"
}> {}

const make = Effect.gen(function* (_) {
  const rest = yield* _(DiscordREST)
  const gateway = yield* _(DiscordGateway)

  const botUser = yield* _(
    rest.getCurrentUser(),
    Effect.flatMap(_ => _.json),
  )

  const run = gateway.handleDispatch("MESSAGE_CREATE", message =>
    pipe(
      Effect.succeed(message),
      Effect.filterOrFail(
        message => message.mentions.some(_ => _.id === botUser.id),
        () => new NonEligibleMessage({ reason: "non-mentioned" }),
      ),
      Effect.zipRight(
        rest.createMessage(message.channel_id, {
          message_reference: {
            message_id: message.id,
          },
          // TODO: Get context and call out to OpenAI
          content: "Hello!",
        }),
      ),
      Effect.catchTags({
        NonEligibleMessage: () => Effect.unit(),
      }),
      Effect.catchAllCause(Effect.logErrorCause),
    ),
  )

  yield* _(run)
})

export const MentionsLive = Layer.effectDiscard(make)
