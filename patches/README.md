# Dependency patches

## @effect/ai-openai 4.0.2

The Responses request builder overwrites explicit `config.include` values with
its computed include set. The scoped patch seeds that set from `config.include`
in both the TypeScript source and published JavaScript, preserving configured
fields alongside automatically requested fields.

`/ai` explicitly requests `reasoning.encrypted_content` for stateless
`gpt-6.1-sol` tool-call continuations because this adapter does not recognize
that model as a reasoning model. Remove the patch when upgrading to a release
that preserves explicit includes. Keep the command override unless the adapter
also requests encrypted reasoning for this model.

As of 2026-10-10, published `@effect/ai-openai` 4.0.3 preserves explicit
includes and uses future-proof reasoning-model detection. However, it and
`@effect/platform-node` 4.0.3 require `effect@^4.0.3`, while npm still exposes
only Effect 4.0.2 as the latest stable release and returns 404 for Effect 4.0.3
(including its tarball). Keep the compatible 4.0.2 packages and patch until
the required core release is available. Then upgrade the catalog, remove the
patched dependency entry and this patch, regenerate the lockfile, and rerun
the regression, check, and build.

The regression in `packages/discord-bot/test/AiResponse.test.ts` uses the real
adapter with mocked HTTP responses. It verifies the include field and replay of
encrypted reasoning and tool results, not Discord wiring or authenticated
endpoint behavior. Model availability, encrypted-reasoning support, and server
acceptance of the continuation still require live validation.
