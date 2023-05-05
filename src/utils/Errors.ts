import { Effect } from "bot/_common"
import { Log } from "dfx"
import { DiscordRESTError } from "dfx/DiscordREST"

export const logRESTError = (_: DiscordRESTError) =>
  "response" in _.error
    ? Effect.flatMap(_.error.response.json, _ =>
        Effect.logInfo(JSON.stringify(_, null, 2)),
      )
    : Effect.tap(Log.Log, log => log.info(_.error))
