import { Effect } from "bot/_common"
import { Log } from "dfx"
import { DiscordRESTError } from "dfx/DiscordREST"

export const logRESTError = (log: Log.Log) => (_: DiscordRESTError) =>
  "response" in _.error
    ? Effect.flatMap(_.error.response.json, _ =>
        Effect.logInfo(JSON.stringify(_, null, 2)),
      )
    : log.info(_.error)
