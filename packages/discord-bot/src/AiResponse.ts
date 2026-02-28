import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { DiscordApplication } from "@chat/discord/DiscordRest"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { Discord, DiscordREST, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Data, Effect, FiberMap, Layer, Ref, Schema, Stream } from "effect"
import { Chat, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { AiHelpers, OpenAiLive } from "./Ai.ts"
import { ChannelsCache } from "./ChannelsCache.ts"
import { EffectRepo, EffectRepoError } from "./EffectRepo.ts"

const Tools = Toolkit.make(
  Tool.make("read", {
    description: "Read a file from the effect repository",
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description:
          "The path to the file to read, relative to the root of the repository"
      }),
      startLine: Schema.optionalKey(Schema.Number).annotate({
        description: "The line number to start reading from (inclusive)"
      }),
      endLine: Schema.optionalKey(Schema.Number).annotate({
        description: "The line number to stop reading at (exclusive)"
      })
    }),
    failure: EffectRepoError,
    success: Schema.String
  }),
  Tool.make("rg", {
    description: "Wrapper around the 'rg' command.",
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({
        description: "The pattern to pass to rg."
      }),
      glob: Schema.optionalKey(Schema.String).annotate({
        description: "The --glob option to rg"
      }),
      maxLines: Schema.Finite.annotate({
        description:
          "The total maximum number of lines to return across all files"
      })
    }),
    failure: EffectRepoError,
    success: Schema.String
  }),
  Tool.make("glob", {
    description: "Find files in the effect repository matching a glob pattern",
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({
        description: "The glob pattern to match files against (e.g. '**/*.ts')"
      })
    }),
    failure: EffectRepoError,
    success: Schema.String
  })
)

const ToolsLayer = Tools.toLayer(Effect.gen(function*() {
  const repo = yield* EffectRepo

  return Tools.of({
    read: Effect.fn(function*({ endLine, path, startLine }) {
      const content = yield* repo.readFileRange({ path, startLine, endLine })
      return content
    }),
    rg: Effect.fn(function*({ glob, maxLines, pattern }) {
      const matches = yield* repo.search({
        pattern,
        glob
      }).pipe(
        Stream.take(maxLines),
        Stream.runCollect
      )
      return matches.join("\n")
    }),
    glob: Effect.fn(function*({ pattern }) {
      const files = yield* repo.glob({ pattern })
      return files.join("\n")
    })
  })
})).pipe(Layer.provide(EffectRepo.layer))

export const AiResponse = Layer.effectDiscard(Effect.gen(function*() {
  const repo = yield* EffectRepo
  const tools = yield* Tools
  const channels = yield* ChannelsCache
  const ai = yield* AiHelpers
  const fiberMap = yield* FiberMap.make<Discord.Snowflake>()

  const command = Ix.global(
    {
      name: "ai",
      description: "Request AI to respond in the thread",
      dm_permission: false,
      default_member_permissions: Number(Discord.Permissions.ManageMessages),
      options: [
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "public",
          description: "Make the results visible for everyone",
          required: true
        }
      ]
    },
    Effect.fnUntraced(function*(ix) {
      const context = yield* Ix.Interaction
      const channel = yield* channels.get(
        context.guild_id!,
        context.channel!.id
      )

      yield* Effect.annotateCurrentSpan({
        channelId: channel.id
      })

      if (channel.type !== Discord.ChannelTypes.PUBLIC_THREAD) {
        return yield* new NotInThreadError()
      }

      const llmsMd = yield* repo.llmsMd

      const history = (yield* ai.generateAiInput(channel)).pipe(
        Prompt.setSystem(
          `You are an assistant for the Effect Discord server. Respond to the conversation, using the following tools when appropriate:

- \`read\`: Read a file (or part of a file) from the effect repository.
- \`rg\`: Use "rg" to find files in the effect repository. The pattern is passed directly to rg using child process apis, so adjust escaping accordingly.
- \`glob\`: Find files in the effect repository matching a glob pattern.

Do not use emojis or excessive formatting in your responses. Be concise and to the point.
**You must** keep responses under 1500 characters.

The effect repository can be found at: https://github.com/Effect-TS/effect-smol
If mentioning files from the repository, create a github link to the file or lines in the repository.
For example:

[src/Effect.ts](https://github.com/Effect-TS/effect-smol/blob/main/src/Effect.ts#L123)

Here is a copy of the LLMS.md document from the root of the effect repository, to help get you started:

${llmsMd}`
        )
      )

      yield* FiberMap.run(fiberMap, context.id, generate(context, history))

      const isPublic = ix.optionValue("public")
      if (!isPublic) {
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "The clanker is thinking...",
            flags: Discord.MessageFlags.Ephemeral
          }
        })
      }

      return Ix.response({
        type:
          Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      })
    })
  )

  const application = yield* DiscordApplication
  const rest = yield* DiscordREST
  const chatModel = yield* OpenAiLanguageModel.model("gpt-5.2")
  const generate = Effect.fn("AiResponse.generate")(
    function*(
      context: Discord.APIInteraction,
      prompt: Prompt.Prompt
    ) {
      const chat = yield* Chat.fromPrompt(prompt)

      while (true) {
        const response = yield* chat.generateText({
          toolkit: tools,
          prompt: []
        })
        if (response.toolCalls.length > 0 || response.text.length === 0) {
          continue
        }
        yield* rest.updateOriginalWebhookMessage(
          application.id,
          context.token,
          {
            payload: {
              content: response.text
            }
          }
        )
        break
      }
    },
    Effect.provide(chatModel),
    Effect.withSpan("AiResponse.generate (inner)"),
    (effect, context) =>
      Effect.onError(
        effect,
        (_) =>
          rest.deleteOriginalWebhookMessage(
            application.id,
            context.token,
            {}
          ).pipe(
            Effect.retry({ times: 3 }),
            Effect.orDie
          )
      )
  )

  const registry = yield* InteractionsRegistry
  yield* registry.register(
    Ix.builder.add(command).catchAllCause(Effect.logError)
  )
})).pipe(
  Layer.provide([
    ToolsLayer,
    EffectRepo.layer,
    ChannelsCache.layer,
    AiHelpers.layer,
    OpenAiLive
  ]),
  Layer.provide(DiscordGatewayLayer)
)

export class NotInThreadError extends Data.TaggedError(
  "NotInThreadError"
) {}
