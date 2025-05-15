import { MessageLogger } from "@chat/domain/MessageLogger"
import { Effect } from "effect"

export const MessageLoggerEntity = MessageLogger.toLayer(
  Effect.gen(function*() {
    return {
      log: Effect.fnUntraced(function*({ payload }) {
        yield* Effect.log("MessageLogger", payload)
      })
    }
  })
)
