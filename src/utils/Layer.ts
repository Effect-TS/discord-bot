import { Config, Context, Effect, Layer } from "effect"

export const config =
  <A>(tag: Context.Tag<A, A>) =>
  (config: Config.Config.Wrap<A>) =>
    Layer.effect(tag, Effect.config(Config.unwrap(config)))
