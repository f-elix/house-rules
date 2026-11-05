# Error Handling — details

Read [error-handling.md]({{rel:docs/conventions/error-handling.md}}) first.

## Error messages

Adapted from the error design section of the [cf-workflow-pool coding standards](https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/coding-standards.md#error-design).

- Say which operation or outcome failed, with the most specific reason that is safe to give.
- Tell the reader what they can do: correct the input, retry, or contact support. Reassure only about what the application can prove was unaffected (for example, that no payment was taken).
- Calm and direct: no blame, no jokes, no implementation jargon.
- In a translated app, a message a user reads comes from the translation catalog, built when the error is created so it is in the request's language.

## Recovering

- Translate a module's own errors by tag with `Effect.catchTag` or `Effect.catchTags`. Name each source error, and translate each one by what it means here. Don't tell them apart with `instanceof` or a broad `Effect.mapError`. The `house-effect/no-instanceof-in-effect-error-handler` lint rule flags `instanceof` inside an Effect error handler. When several error classes share one tag on purpose, list them in the rule's `allow` option.
- No catch-all that classifies errors nobody has seen yet. A tag left untranslated stays in the error channel, so a newly added failure shows up in the type until someone decides what it means.
- `Effect.mapError` is right when the whole channel means one thing, such as wrapping every failure of one vendor call in its infra error.
- `Effect.catch` that swallows a failure is only for best-effort work whose failure must not fail the request, such as an internal notification email after a completed order. Log the failure there, since nothing else will.

## Logging

- The runner is the only reporter: it logs every error and defect it receives, and sends them to the error tracker if the repo has one. Fail with the error and let it reach the runner. Don't log an error and then fail with it: the entry appears twice.
- Log through Effect (`Effect.logInfo`, `Effect.logWarning`, `Effect.logError`), so the line carries the request annotations.
