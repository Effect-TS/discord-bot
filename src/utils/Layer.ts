import { Config, Context, Effect, Layer } from "effect"

export const config =
  <I, A>(tag: Context.Tag<I, A>) =>
  (config: Config.Config.Wrap<A>) =>
    Layer.effect(tag, Effect.config(Config.unwrap(config)))
