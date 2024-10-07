import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Schema } from "@effect/schema"
import { Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Effect, flow, Layer, Schedule } from "effect"
import { DiscordLive } from "./Discord.js"

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://icanhazdadjoke.com"),
        HttpClientRequest.acceptJson,
      ),
    ),
  )

  const getJoke = client.get("/").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Joke)),
    Effect.scoped,
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential(200),
    }),
    Effect.orDie,
    Effect.withSpan("DadJokes.getJoke"),
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
