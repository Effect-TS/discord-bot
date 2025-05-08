import { PgClient } from "@effect/sql-pg"
import { Config } from "effect"
import { constVoid } from "effect/Function"

export const SqlClientLayer = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  onnotice: Config.succeed(constVoid)
})
