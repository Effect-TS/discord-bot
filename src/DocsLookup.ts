import { Discord, Ix } from "dfx"
import { InteractionsRegistry, InteractionsRegistryLive } from "dfx/gateway"
import * as HtmlEnt from "html-entities"
import * as Prettier from "prettier"
import {
  Data,
  Duration,
  Effect,
  Http,
  Layer,
  Option,
  Schedule,
  Schema,
  SchemaClass,
  identity,
  pipe,
} from "./_common.js"

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

const make = Effect.gen(function* (_) {
  const registry = yield* _(InteractionsRegistry)

  const loadDocs = (baseUrl: string) =>
    pipe(
      Http.get(`${baseUrl}/assets/js/search-data.json`),
      Http.fetchJson(),
      Effect.retry(retryPolicy),
      Effect.map(_ => Object.values(_ as object)),
      Effect.flatMap(decodeEntries),
      Effect.map(entries => entries.filter(_ => _.isSignature)),
    )

  const allDocs = yield* _(
    Effect.forEachPar(docUrls, loadDocs),
    Effect.map(_ =>
      _.flat().reduce((acc, entry) => {
        acc[entry.searchTerm] = entry
        return acc
      }, {} as Record<string, DocEntry>),
    ),
    Effect.map(map => ({
      forSearch: Object.entries(map).map(([key, entry]) => ({
        term: key.toLowerCase(),
        key,
        label: `${entry.signature} (${entry.package})`,
        entry,
      })),
      map,
    })),
    Effect.cachedWithTTL(Duration.hours(3)),
  )

  // prime the cache
  yield* _(allDocs)

  const search = (query: string) => {
    query = query.toLowerCase()
    return pipe(
      Effect.logDebug("searching"),
      Effect.zipRight(allDocs),
      Effect.map(({ forSearch }) =>
        forSearch.filter(_ => _.term.includes(query)),
      ),
      Effect.logAnnotate("module", "DocsLookup"),
      Effect.logAnnotate("query", query),
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
          autocomplete: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "public",
          description: "Make the results visible for everyone",
          required: false,
        },
      ],
    },
    ix =>
      pipe(
        Effect.all({
          key: ix.optionValue("query"),
          reveal: Effect.someOrElse(
            ix.optionValueOptional("public"),
            () => false,
          ),
          docs: allDocs,
        }),
        Effect.bind("entry", ({ key, docs }) =>
          Option.fromNullable(docs.map[key]),
        ),
        Effect.bind("embed", ({ entry }) => entry.embed),
        Effect.map(({ embed, reveal }) =>
          Ix.response({
            type: Discord.InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: reveal ? undefined : Discord.MessageFlag.EPHEMERAL,
              embeds: [embed],
            },
          }),
        ),
        Effect.catchTags({
          NoSuchElementException: () =>
            Effect.succeed(
              Ix.response({
                type: Discord.InteractionCallbackType
                  .CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                  flags: Discord.MessageFlag.EPHEMERAL,
                  content: `Sorry, that query could not found.`,
                },
              }),
            ),
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
              ({ label, key }): Discord.ApplicationCommandOptionChoice => ({
                name: label,
                value: key,
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

// schema

class DocEntry extends SchemaClass({
  doc: Schema.string,
  title: Schema.string,
  content: Schema.string,
  url: pipe(
    Schema.string,
    Schema.transform(
      Schema.string,
      path => `https://effect-ts.github.io${path}`,
      identity,
    ),
  ),
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

  get formattedContent() {
    return Effect.forEach(
      this.content
        .split(" . ")
        .map(_ => _.trim())
        .filter(_ => _.length)
        .map(_ => HtmlEnt.decode(_)),
      text =>
        text.startsWith("export ") ? wrapCodeBlock(text) : Effect.succeed(text),
    )
  }

  get embed() {
    return pipe(
      this.formattedContent,
      Effect.map((content): Discord.Embed => {
        const footer = content.pop()!

        return {
          author: {
            name: this.package,
          },
          title: this.signature,
          description: content.join("\n\n"),
          color: 0x882ecb,
          url: this.url,
          footer: {
            text: footer,
          },
        }
      }),
    )
  }
}

const decodeEntries = Schema.parseEffect(Schema.array(DocEntry.schema()))

// errors

class QueryTooShort extends Data.TaggedClass("QueryTooShort")<{
  readonly actual: number
  readonly min: number
}> {}

const retryPolicy = Schedule.fixed(Duration.seconds(3))

// helpers

const wrapCodeBlock = (code: string) =>
  pipe(
    Effect.try(() => {
      const codeWithNewlines = code
        .replace(
          / (<|\[|readonly|(?<!readonly |\()\b\w+\??:|\/\*\*|\*\/? |export declare)/g,
          "\n$1",
        )
        .replace(/\*\//g, "*/\n")

      return Prettier.format(codeWithNewlines, {
        parser: "typescript",
        trailingComma: "all",
        semi: false,
        arrowParens: "avoid",
      })
    }),
    Effect.catchAllCause(_ => Effect.succeed(code)),
    Effect.map(_ => "```typescript\n" + _ + "\n```"),
  )
