import { Workflow } from "@effect/workflow"
import { Schema } from "effect"

export const MessageWorkflow = Workflow.make({
  name: "MessageWorkflow",
  payload: {
    id: Schema.String,
    message: Schema.String,
    author: Schema.String
  },
  idempotencyKey: ({ id }) => id
})
