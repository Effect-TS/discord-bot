import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Schema } from "@effect/schema"
import { DiscordIxLive, InteractionsRegistry } from "dfx/gateway"
import { Ix } from "dfx"
import { Effect, flow, Layer, Schedule } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { DiscordLive } from "./Discord.js"

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(HttpClientRequest.prependUrl("https://icanhazdadjoke.com")),
    ),
  )

  const getJoke = HttpClientRequest.get("/").pipe(
    HttpClientRequest.acceptJson,
    client,
    HttpClientResponse.schemaBodyJsonScoped(Joke),
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential(200),
    }),
    Effect.orDie,
  )

  // discord

  const registry = yield* InteractionsRegistry
  const command = Ix.global(
    {
      name: "dadjoke",
      description: "Display a random dad joke",
    },
    getJoke.pipe(
      Effect.map(joke =>
        Ix.response({
          type: 4,
          data: {
            content: joke.joke,
          },
        }),
      ),
    ),
  )
  yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log))
})

export const DadJokesLive = Layer.effectDiscard(make).pipe(
  Layer.provide(DiscordLive),
)

class Joke extends Schema.Class<Joke>("DadJokes/Joke")({
  joke: Schema.String,
}) {}
