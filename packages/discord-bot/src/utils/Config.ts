import { ConfigProvider } from "effect"

export const nestedConfigProvider = (prefix: string) =>
  ConfigProvider.fromEnv().pipe(
    ConfigProvider.nested(prefix),
    ConfigProvider.constantCase
  )
