import * as AutoThreads from "bot/AutoThreads"
import { BotLive } from "bot/Bot"
import * as OpenAI from "bot/OpenAI"
import { Config, Effect, Layer, pipe } from "bot/_common"
import { Intents } from "dfx"
import { makeLive } from "dfx/gateway"
import * as Dotenv from "dotenv"

Dotenv.config()

const DiscordLive = makeLive({
  token: Config.secret("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(
      Intents.fromList(["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILDS"]),
    ),
  },
})

const OpenAILive = OpenAI.makeLayer({
  apiKey: Config.secret("OPENAI_API_KEY"),
  organization: Config.optional(Config.secret("OPENAI_ORGANIZATION")),
})

const AutoThreadsLive = AutoThreads.makeLayer({
  topicKeyword: Config.withDefault(
    Config.string("AUTOTHREADS_KEYWORD"),
    "[threads]",
  ),
})

const MainLive = pipe(
  DiscordLive,
  Layer.merge(OpenAILive),
  Layer.provide(Layer.merge(AutoThreadsLive, BotLive)),
)

pipe(
  Layer.launch(MainLive),
  Effect.tapErrorCause(Effect.logErrorCause),
  Effect.runFork,
)
