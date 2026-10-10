import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Effect, Layer, Schema } from "effect"
import { Chat, Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { expect, it } from "vitest"

it("requests and replays encrypted reasoning across a stateless tool call", () => {
  const Request = Schema.Struct({
    model: Schema.String,
    store: Schema.Boolean,
    include: Schema.optionalKey(Schema.Array(Schema.String)),
    input: Schema.Array(Schema.Unknown),
  })
  const requests: Array<typeof Request.Type> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") {
        throw new Error("Expected a JSON request body")
      }
      const body = Schema.decodeSync(Schema.fromJsonString(Request))(
        new TextDecoder().decode(request.body.body),
      )
      requests.push(body)
      const output =
        requests.length === 1
          ? [
              {
                type: "reasoning",
                id: "rs_1",
                summary: [],
                ...(body.include?.includes("reasoning.encrypted_content")
                  ? { encrypted_content: "encrypted-reasoning" }
                  : {}),
              },
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "read",
                arguments: '{"path":"README.md"}',
                status: "completed",
              },
            ]
          : [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "Done", annotations: [] },
                ],
              },
            ]
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
            id: `resp_${requests.length}`,
            model: "gpt-6.1-sol",
            created_at: 0,
            output,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
  const tools = Toolkit.make(
    Tool.make("read", {
      parameters: Schema.Struct({ path: Schema.String }),
      success: Schema.String,
    }),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const chat = yield* Chat.fromPrompt("Read README.md and summarize it")
      const first = yield* chat.generateText({ prompt: [], toolkit: tools })
      expect(first.toolCalls).toHaveLength(1)
      const result = yield* chat.generateText({ prompt: [], toolkit: tools })
      expect(result.text).toBe("Done")
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(request.model).toBe("gpt-6.1-sol")
        expect(request.store).toBe(false)
        expect(request.include).toEqual(["reasoning.encrypted_content"])
      }
      expect(requests[1].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            encrypted_content: "encrypted-reasoning",
          }),
          expect.objectContaining({
            type: "function_call_output",
            call_id: "call_1",
            output: "README contents",
          }),
        ]),
      )
    }).pipe(
      OpenAiLanguageModel.withConfigOverride({
        store: false,
        reasoning: { effort: "medium" },
        include: ["reasoning.encrypted_content"],
      }),
      Effect.provide([
        tools.toLayer({ read: () => Effect.succeed("README contents") }),
        OpenAiLanguageModel.layer({ model: "gpt-6.1-sol" }).pipe(
          Layer.provide(OpenAiClient.layer({})),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ]),
    ),
  )
})
