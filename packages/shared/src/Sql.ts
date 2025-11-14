import { PgClient } from "@effect/sql-pg"
import { Config } from "effect"

export const SqlClientLayer = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL")
})
