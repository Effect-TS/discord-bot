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

The regression in `packages/discord-bot/test/AiResponse.test.ts` uses the real
adapter with mocked HTTP responses. It verifies the include field and replay of
encrypted reasoning and tool results, not Discord wiring or authenticated
endpoint behavior. Model availability, encrypted-reasoning support, and server
acceptance of the continuation still require live validation.
