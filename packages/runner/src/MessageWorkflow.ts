import { MessageWorkflow } from "@chat/domain/MessageWorkflow"
import { Activity, DurableClock } from "@effect/workflow"
import { Effect } from "effect"

export const MessageWorkflowLayer = MessageWorkflow.toLayer(
  Effect.fnUntraced(
    function*({ author }, _executionId) {
      yield* Effect.log("Running")

      yield* DurableClock.sleep({
        name: "Wait 2 minutes",
        duration: "2 minutes"
      })

      yield* Effect.log("Starting big sleep")

      yield* DurableClock.sleep({
        name: "Wait 1 day",
        duration: "1 day"
      })

      yield* Activity.make({
        name: "TestActivity",
        execute: Effect.log("Executing TestActivity")
      }).pipe(
        MessageWorkflow.withCompensation(Effect.fn(function*() {
          yield* Effect.log("Compensating TestActivity")
        }))
      )

      if (author === "timsmart") {
        return yield* Effect.die("TimSmart is not allowed to send messages")
      }

      yield* Effect.log("Done")
    },
    (effect, { author, id, message }, executionId) =>
      Effect.annotateLogs(effect, {
        workflow: "MessageWorkflow",
        id,
        message,
        author,
        executionId
      })
  )
)
