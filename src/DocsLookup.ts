import { Discord, Ix } from "dfx"
import {
  Data,
  Duration,
  Effect,
  Http,
  Layer,
  Schedule,
  Schema,
  SchemaClass,
  pipe,
} from "./_common.js"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"
import * as HtmlEnt from "html-entities"

const docUrls = [
  "https://effect-ts.github.io/cli",
  "https://effect-ts.github.io/data",
  "https://effect-ts.github.io/io",
  "https://effect-ts.github.io/match",
  "https://effect-ts.github.io/rpc",
  "https://effect-ts.github.io/schema",
  "https://effect-ts.github.io/stm",
  "https://effect-ts.github.io/stream",
]

class DocEntry extends SchemaClass({
  doc: Schema.string,
  title: Schema.string,
  content: Schema.string,
  url: Schema.string,
  relUrl: Schema.string,
}) {
  get isSignature() {
    return (
      this.content.trim().length > 0 &&
      this.url.includes("#") &&
      !this.title.includes(" overview")
    )
  }

  get subpackage() {
    const [, subpackage, suffix] = this.url.match(/github\.io\/(.+?)\/(.+?)\//)!
    return suffix !== "modules" && subpackage !== suffix
      ? `${subpackage}-${suffix}`
      : subpackage
  }

  get package() {
    return `@effect/${this.subpackage}`
  }

  get module() {
    return this.doc.replace(/\.ts$/, "")
  }

  get signature() {
    return `${this.module}.${this.title}`
  }

  get searchTerm(): string {
    return `/${this.subpackage}/${this.module}.${this.title}`
  }

  get formattedContent(): string {
    return this.content
      .split(" . ")
      .map(_ => HtmlEnt.decode(_))
      .map(text =>
        text.startsWith("export ") ? "```typescript\n" + text + "\n```" : text,
      )
      .join("\n")
  }
}

const decodeEntries = Schema.parseEffect(Schema.array(DocEntry.schema()))

class QueryTooShort extends Data.TaggedClass("QueryTooShort")<{
  readonly actual: number
  readonly min: number
}> {}

const retryPolicy = Schedule.fixed(Duration.seconds(3))

const make = Effect.gen(function* (_) {
  const registry = yield* _(InteractionsRegistry)

  const buildDocs = (baseUrl: string) =>
    Effect.gen(function* (_) {
      const searchData = yield* _(
        Http.get(`${baseUrl}/assets/js/search-data.json`),
        Http.fetchJson(),
        Effect.retry(retryPolicy),
        Effect.map(_ => Object.values(_ as object)),
        Effect.flatMap(_ => decodeEntries(_)),
        Effect.map(entries =>
          entries
            .filter(_ => _.isSignature)
            .map(entry =>
              entry.copyWith({
                url: `${baseUrl}${entry.relUrl}`,
              }),
            ),
        ),
      )

      return searchData.map(entry => ({
        term: entry.searchTerm,
        entry,
      }))
    })

  const allDocs = yield* _(
    Effect.forEachPar(docUrls, buildDocs),
    Effect.map(_ => _.flat()),
    Effect.cachedWithTTL(Duration.hours(3)),
  )

  // prime the cache
  yield* _(allDocs)

  const search = (query: string) =>
    pipe(
      Effect.logDebug("searching"),
      Effect.zipRight(allDocs),
      Effect.map(_ =>
        _.map((_, index) => [_, index] as const).filter(([_]) =>
          _.term.includes(query),
        ),
      ),
      Effect.logAnnotate("module", "DocsLookup"),
      Effect.logAnnotate("query", query),
    )

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
          autocomplete: true,
        },
      ],
    },
    ix =>
      pipe(
        Effect.all({
          index: ix.optionValue("query"),
          docs: allDocs,
        }),
        Effect.map(({ index, docs }) => {
          const entry = docs[Number(index)].entry

          return Ix.response({
            type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `View the documentation for \`${entry.signature}\` from \`${entry.package}\` here:
${entry.url}

${entry.formattedContent}`,
            },
          })
        }),
      ),
  )

  const autocomplete = Ix.autocomplete(
    Ix.option("docs", "query"),
    pipe(
      Ix.focusedOptionValue,
      Effect.filterOrElseWith(
        _ => _.length >= 3,
        _ => Effect.fail(new QueryTooShort({ actual: _.length, min: 3 })),
      ),
      Effect.flatMap(search),
      Effect.map(results =>
        Ix.response({
          type: Discord.InteractionCallbackType
            .APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: {
            choices: results.slice(0, 25).map(
              ([{ entry }, index]): Discord.ApplicationCommandOptionChoice => ({
                name: `${entry.signature} (${entry.package})`,
                value: index.toString(),
              }),
            ),
          },
        }),
      ),
      Effect.catchTags({
        QueryTooShort: _ =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackType
                .APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
              data: { choices: [] },
            }),
          ),
      }),
    ),
  )

  const ix = Ix.builder
    .add(command)
    .add(autocomplete)
    .catchAllCause(Effect.logErrorCause)

  yield* _(registry.register(ix))
})

export const DocsLookupLive = Layer.provide(
  InteractionsRegistryLive,
  Layer.effectDiscard(make),
)
