import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Discord, Ix } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import {
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Resource,
  Schedule,
  Schema
} from "effect"
import type { Mutable } from "effect/Types"
import fuzzysort from "fuzzysort"
import * as Prettier from "prettier"

const docUrls = [
  "https://raw.githubusercontent.com/tim-smart/effect-io-ai/refs/heads/main/json/_all.json"
]

const make = Effect.gen(function*() {
  const registry = yield* InteractionsRegistry

  const docsClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retry(retryPolicy)
  )

  const loadDocs = (url: string) =>
    Effect.flatMap(
      docsClient.get(url),
      HttpClientResponse.schemaBodyJson(DocEntry.Array)
    )

  const docs = yield* Resource.auto(
    Effect.forEach(docUrls, loadDocs, {
      concurrency: docUrls.length
    }).pipe(
      Effect.map((_) =>
        _.flat().reduce(
          (acc, entry) => {
            acc[entry.searchTerm] = entry
            return acc
          },
          {} as Record<string, DocEntry>
        )
      ),
      Effect.map((map) => ({
        forSearch: Object.entries(map).map(([key, entry]) => ({
          term: entry.preparedFuzzySearch,
          key,
          label: `${entry.nameWithModule} (${entry._tag}) (${entry.project})`,
          entry
        })),
        map
      }))
    ),
    Schedule.spaced(Duration.hours(3))
  )

  const search = (query: string) => {
    query = query.toLowerCase()
    return Effect.logDebug("searching").pipe(
      Effect.zipRight(Resource.get(docs)),
      Effect.map(({ forSearch }) =>
        fuzzysort.go(query, forSearch, { key: "term" }).map((x) => x.obj)
      ),
      Effect.annotateLogs("module", "DocsLookup"),
      Effect.annotateLogs("query", query),
      Effect.withSpan("DocsLookup.search", { attributes: { query } })
    )
  }

  const command = Ix.global(
    {
      name: "docs",
      description: "Search the Effect reference docs",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "query",
          description: "The query to search for",
          required: true,
          autocomplete: true
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "public",
          description: "Make the results visible for everyone",
          required: true
        }
      ]
    },
    Effect.fn("DocsLookup.command")(
      function*(ix) {
        const key = ix.optionValue("query")
        const reveal = ix.optionValue("public")
        const { map } = yield* Resource.get(docs)
        const entry = yield* Effect.fromNullable(map[key])
        yield* Effect.annotateCurrentSpan({
          entry: entry.nameWithModule,
          public: reveal
        })
        const embed = yield* entry.embed
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: reveal ? undefined as any : Discord.MessageFlags.Ephemeral,
            embeds: [embed]
          }
        })
      },
      Effect.catchTags({
        NoSuchElementException: () =>
          Effect.succeed(
            Ix.response({
              type:
                Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: Discord.MessageFlags.Ephemeral,
                content: `Sorry, that query could not be found.`
              }
            })
          )
      })
    )
  )

  const autocomplete = Ix.autocomplete(
    Ix.option("docs", "query"),
    Effect.gen(function*() {
      const query = String(yield* Ix.focusedOptionValue)
      yield* Effect.annotateCurrentSpan("query", query)
      if (query.length < 3) {
        return yield* new QueryTooShort({ actual: query.length, min: 3 })
      }
      const results = yield* search(query)
      return Ix.response({
        type: Discord.InteractionCallbackTypes
          .APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: {
          choices: results.slice(0, 25).map(
            ({ key, label }) => ({
              name: label,
              value: key
            })
          )
        }
      })
    }).pipe(
      Effect.catchTags({
        QueryTooShort: (_) =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes
                .APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
              data: { choices: [] }
            })
          )
      }),
      Effect.withSpan("DocsLookup.autocomplete")
    )
  )

  const ix = Ix.builder
    .add(command)
    .add(autocomplete)
    .catchAllCause(Effect.logError)

  yield* registry.register(ix)
})

export const DocsLookupLive = Layer.scopedDiscard(make).pipe(
  Layer.provide(DiscordGatewayLayer)
)

// schema

class DocEntry extends Schema.Class<DocEntry>("DocEntry")({
  _tag: Schema.String,
  module: Schema.Struct({
    name: Schema.String
  }),
  project: Schema.String,
  name: Schema.String,
  description: Schema.optionalWith(Schema.String, {
    as: "Option",
    nullable: true
  }),
  deprecated: Schema.Boolean,
  examples: Schema.Array(Schema.String),
  since: Schema.String,
  category: Schema.optionalWith(Schema.String, {
    as: "Option",
    nullable: true
  }),
  signature: Schema.optionalWith(Schema.String, {
    as: "Option",
    nullable: true
  }),
  sourceUrl: Schema.String
}) {
  static readonly Array = Schema.Array(this)
  static readonly decode = Schema.decodeUnknown(this)
  static readonly decodeArray = Schema.decodeUnknown(this.Array)

  get url() {
    const project = this.project === "effect"
      ? "effect/effect"
      : this.project.replace(/^@/g, "")
    return `https://effect-ts.github.io/${project}/${this.module.name}.html#${this.name.toLowerCase()}`
  }

  get moduleTitle() {
    return this.module.name.replace(/\.[^/.]+$/, "")
  }

  get nameWithModule() {
    return `${this.moduleTitle}.${this.name}`
  }

  get isSignature() {
    return Option.isSome(this.signature)
  }

  get searchTerm(): string {
    return `/${this.project}/${this.moduleTitle}.${this.name}.${this._tag}`
  }

  readonly preparedFuzzySearch = fuzzysort.prepare(
    `${this.moduleTitle}.${this.name}`
  )

  get embed(): Effect.Effect<Discord.RichEmbed> {
    return Effect.gen(this, function*() {
      const embed: Mutable<Discord.RichEmbed> = {
        author: {
          name: this.project
        },
        title: this.nameWithModule,
        color: 0x882ecb,
        url: this.url,
        description: Option.getOrElse(this.description, () => ""),
        fields: [
          {
            name: " ",
            value: `[View source](${this.sourceUrl})`
          }
        ],
        footer: {
          text: `Added in v${this.since}`
        }
      }

      if (Option.isSome(this.signature)) {
        embed.description += "\n\n```ts\n" +
          (yield* prettify(this.signature.value)) + "\n```"
      }

      if (this.examples.length > 0) {
        embed.description += "\n\n**Example**"
        for (const example of this.examples) {
          embed.description += "\n\n```ts\n" + example + "\n```"
        }
      }

      return embed
    })
  }
}

// prettier

const prettify = (code: string) =>
  Effect.tryPromise(() =>
    Prettier.format(code, {
      parser: "typescript",
      semi: false
    })
  ).pipe(Effect.orElseSucceed(() => code))

// errors

class QueryTooShort extends Data.TaggedError("QueryTooShort")<{
  readonly actual: number
  readonly min: number
}> {}

const retryPolicy = Schedule.spaced(Duration.seconds(3))
