# Error Handling

Server code fails through the Effect error channel; [effect.md]({{rel:docs/conventions/effect.md}}) covers the runners these errors end up in. Message wording, recovery idioms and logging, checked in review, are in [error-handling.details.md]({{rel:docs/conventions/error-handling.details.md}}).

## What can reach a runner

A runner knows a small, fixed set of failure kinds, defined together in one module. Every failure an Effect can end in when it reaches a runner must be one of them. The usual set:

| Failure                                                                                    | Who reads `message`         | What the runner does                                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------- |
| An app error, one class per status (400 bad request, 404 not found, 409 conflict, 500 …)   | the user                    | Responds with the status and message. A 500 logs an error; any other status, a warning   |
| An infra error, one class per vendor (the database, the payment provider, the email API …) | the operator                | Responds with a generic 500. Logs an error with the vendor and the operation that failed |
| A redirect                                                                                 | —                           | Responds with the framework's redirect. Not logged                                       |
| A form validation failure                                                                  | the user, next to the field | Responds with the framework's field errors. Not logged                                   |

**Translate every other error before the runner.** A runner accepts any error type, so TypeScript won't stop a domain error from reaching it, and one that does is handled as a defect: the user gets a generic 500 instead of the status and message the failure deserves. A module's own errors (`Data.TaggedError`, such as `EmailAlreadyExists`) and the `SchemaError` a decode fails with are translated where their meaning is known, usually the handler that calls the service:

```ts
Effect.gen(function* () {
	const profile = yield* Profile;
	yield* profile.update(data);
	// …
}).pipe(
	Effect.catchTag(
		'EmailAlreadyExists',
		() => new ConflictError({ message: 'An account already uses this email.' })
	),
	withProfile
);
```

## Choosing the error

- A vendor call that fails fails with that vendor's infra error, built in the `catch` of `Effect.tryPromise`, with the `operation` that failed and the original error as `cause`.
- A condition the user can act on (bad input, a missing resource, a conflict, missing rights) is the matching app error.
- A field-level form problem the schema can't express is a form validation failure, with a path to the field, so the form renders it next to the input like a schema issue.
- A redirect from inside Effect code is a failure the runner turns into a redirect, never a framework helper that throws past the error channel.
- A module-internal condition that a caller has to tell apart from others is its own `Data.TaggedError`, translated before the runner as above.
- A bug (an invariant that can't hold) is a defect: let it die. Don't model it as a typed error nobody handles.

## Typed context, not only a message

An error carries what an operator needs as fields, not only as text in its message:

- `message` is what its reader sees: the user for an app error, the operator for an infra error.
- `logMessage` replaces `message` in the logs when the operator needs more than the user sees.
- `context` holds the safe ids and values that locate the failure (`{ slug }`, `{ orderId }`), and lands in the log annotations.
- `cause` keeps the original error. Always pass it on when wrapping one.

Secrets, tokens, card data and full payloads stay out of all four.
