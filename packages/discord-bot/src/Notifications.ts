import { DiscordGatewayLayer } from "@chat/discord/DiscordGateway"
import assert from "assert"
import { Discord, DiscordREST, Ix, UI } from "dfx"
import { InteractionsRegistry } from "dfx/gateway"
import { Array, Effect, FiberSet, Layer } from "effect"
import { RolesCache } from "./RolesCache.ts"

export const NotificationsLayer = Effect.gen(function*() {
  const ix = yield* InteractionsRegistry
  const rolesCache = yield* RolesCache
  const rest = yield* DiscordREST

  const notificationRoles = Effect.fnUntraced(function*(guildId: string) {
    const roles = yield* rolesCache.getForParent(guildId)
    return Array.fromIterable(roles.values()).filter((role) =>
      role.name.startsWith("🔔 ")
    )
  })

  const message = Effect.fn("Notifications.message")(
    function*(ix: Discord.APIInteraction, userRoles?: Array<string>) {
      const guildId = ix.guild_id
      if (!guildId) {
        return UI.components([
          UI.textDisplay("This command can only be used in a server.")
        ], { ephemeral: true })
      }

      const roles = yield* notificationRoles(guildId)
      if (roles.length === 0) {
        return UI.components([
          UI.textDisplay("No notification roles found in this server.")
        ], { ephemeral: true })
      }

      userRoles = userRoles ?? ix.member!.roles

      return UI.components([
        UI.textDisplay("Select the notifications you want to receive:"),
        UI.row([
          UI.select({
            custom_id: "notifications_role",
            placeholder: "No notifications selected",
            min_values: 0,
            max_values: roles.length,
            options: roles.map((role) => ({
              label: role.name,
              value: role.id,
              default: userRoles.includes(role.id)
            }))
          })
        ])
      ], { ephemeral: true })
    }
  )

  const command = Ix.guild(
    {
      name: "notifications",
      description: "Choose which notifications you want to receive"
    },
    Effect.fn("Notifications.command")(function*(ix) {
      return Ix.response({
        type: 4,
        data: yield* message(ix.interaction)
      })
    })
  )

  const select = Ix.messageComponent(
    Ix.id("notifications_role"),
    Effect.gen(function*() {
      const ix = yield* Ix.Interaction
      const data = yield* Ix.MessageComponentData
      assert(data.component_type === 3)
      const roles = yield* notificationRoles(ix.guild_id!)

      const userRoles = new Set(ix.member?.roles ?? [])
      const fibers = yield* FiberSet.make()
      for (const role of roles) {
        const currentlyHas = userRoles.has(role.id)
        const shouldHave = data.values.includes(role.id)
        if (currentlyHas === shouldHave) {
          continue
        } else if (shouldHave) {
          userRoles.add(role.id)
          yield* FiberSet.run(
            fibers,
            rest.addGuildMemberRole(
              ix.guild_id!,
              ix.member!.user.id,
              role.id
            )
          )
        } else {
          userRoles.delete(role.id)
          yield* FiberSet.run(
            fibers,
            rest.deleteGuildMemberRole(
              ix.guild_id!,
              ix.member!.user.id,
              role.id
            )
          )
        }
      }
      yield* FiberSet.awaitEmpty(fibers)
      return Ix.response({
        type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
        data: yield* message(ix, Array.fromIterable(userRoles))
      })
    })
  )

  yield* ix.register(
    Ix.builder.add(command).add(select).catchAll(Effect.logError)
  )
}).pipe(
  Layer.scopedDiscard,
  Layer.provide([RolesCache.Default, DiscordGatewayLayer])
)
