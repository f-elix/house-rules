# Effect

Server code is written with [Effect](https://effect.website/docs) (v4). Promise-based server code (`async`/`await`, `throw`) is legacy: new server code returns Effects, and code being migrated moves to the patterns on this page. Errors are covered in [error-handling.md]({{rel:docs/conventions/error-handling.md}}).

This page holds what to know before writing; [effect.details.md]({{rel:docs/conventions/effect.details.md}}) holds the idioms and naming checked in review.

## Running effects

An Effect runs only at a boundary: a request handler, a page load, a job or a CLI entry point. Each kind of boundary has one runner, a function that takes the Effect and returns what the framework expects. The runner provides the services every request needs, annotates the logs, logs every failure it receives, and turns a failure into the framework's response ([error-handling.md]({{rel:docs/conventions/error-handling.md}}#what-can-reach-a-runner)). Use the runner for the surface whenever one fits. When none fits, add one rather than running the Effect inline.

An Effect handed to a runner may require only the services the runner provides. Provide every other service before it gets there, with the module's `withX` helper.

`Effect.runPromise` and `Effect.runSync` belong in runners and tests. Elsewhere they skip the runner's services, log annotations and error reporting. A call outside them, such as a config load at import time, gets a comment saying why.

## Services

A domain module exposes its capabilities as `Context.Service`s. A service lives in a file named for its capability (`catalog.ts`, `notifications.ts`). The file holds, in this order:

1. **The interface**, `type XApi = { … }`, with the JSDoc that [comments.md]({{rel:docs/conventions/comments.md}}) asks for on every member. Write it first, by hand: it is the contract callers and tests rely on, and writing it before the body is where a hard-to-describe method shows the design is wrong. Every service declares one. A service that infers its API with `Effect.Success<typeof make>` gets a hand-written `XApi` whenever you touch it.
2. **`make`**, an Effect that yields the services it needs and returns the implementation.
3. **The class**, `class X extends Context.Service<X, XApi>()('X')`, with its layers as static fields: `layer` with the production dependencies, `layerTest` with the test ones. `Layer.effect(this, make)` checks `make` against `XApi`, so a method that drifts from the contract is a compile error.
4. **`withX`** (and `withXTest`), which provides `X.layer` to an Effect. Boundaries call `withX`; tests call `withXTest`.

```ts
/** Lists the plans a customer can buy. */
export type CatalogApi = {
	/** The public plans in display order. */
	readonly listPublicPlans: Effect.Effect<ReadonlyArray<Plan>, DatabaseError>;
};

const make = Effect.gen(function* () {
	const database = yield* Database;
	const listPublicPlans = Effect.gen(function* () {
		// …
	});
	return { listPublicPlans };
});

/** Reads the plans from the database. */
export class Catalog extends Context.Service<Catalog, CatalogApi>()('Catalog') {
	static readonly layer = Layer.effect(this, make).pipe(Layer.provide(Database.layer));
	static readonly layerTest = Layer.effect(this, make).pipe(Layer.provide(Database.layerTest));
}

/** Provides the production `Catalog` to `effect`. */
export const withCatalog = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.provide(effect, Catalog.layer);
```

- `layer` and `layerTest` are each built on their own. Don't derive both from one shared sub-layer: layers are memoized by object, so a nested real `provide` can hand the test instance to production code or the reverse.
- A layer's construction must not read request state (the request, the user, cookies). Read it per call, inside the method.

### Fakes at the edge

A service that wraps a vendor (a database, a payment provider, an email API) gets a `layerTest` backed by an in-memory store, exported as `xTestState`. It crosses the same interface as production and behaves like it: a write is visible to the next read, a missing row is `null` the same way. No partial stubs, and no production behaviour weakened to make the fake easier to write. Services above the vendor run their real `make` against those fakes in `layerTest`, rather than replacing their own logic with a stub: a stubbed `layerTest` leaves every test of that service asserting what the stub returns ([test-cases.md]({{rel:docs/conventions/test-cases.md}}) rule 1).

## Reuse before building

Before writing a helper, a loop, a layer or a service, find what already does the job, in this order:

1. **This repo's services.** Yield the service that already holds the request, the config or the store: it is already wired into the runners and the tests.
2. **Effect itself.** Search the Effect v4 source and docs for a primitive, and say in the PR what you checked.

Substitutions review has already asked for:

| Hand-written                                             | Effect primitive                                |
| -------------------------------------------------------- | ----------------------------------------------- |
| Carrying request state with `Effect.context()`           | A service that holds it, provided by the runner |
| A cursor loop over pages                                 | `Stream.paginate`                               |
| `Effect.all` over writes that must all be attempted      | `Effect.exit` on each, then `Exit.asVoidAll`    |
| `instanceof` on a tagged error                           | `Effect.catchTag` / `Effect.catchTags`          |
| A regex or `if` checking length, emptiness, email format | Schema checks ([§ Schemas](#schemas))           |

## Schemas

Validation uses Effect `Schema`. Build a schema from Effect's checks and transforms (`Schema.Trim`, `Schema.isMinLength`, `Schema.NonEmptyString`, …) as far as they go. Transform before you validate: trim the input, then check it, rather than rejecting untrimmed input. A field's message names the field it's on (an email's "invalid email", a name's "required"), not a generic one.

When the built-ins don't cover a rule, write it where it's used, named for the domain (`PriceSchema`, not `positiveDecimalString`). Move it to a shared module as a generic helper only once several modules use it.

Decode untrusted data (a database row, a vendor payload, a webhook body) with `Schema.decodeUnknownEffect` before it reaches domain code, rather than casting it. It fails with `SchemaError`, which a runner doesn't know ([error-handling.md]({{rel:docs/conventions/error-handling.md}}#what-can-reach-a-runner)): translate it to the vendor's infrastructure error when the vendor sent something unexpected, or `Effect.orDie` when a mismatch can only be our bug.

## Gotchas

- `Effect.promise` turns a rejection into a defect. When the rejection is an expected failure, use `Effect.tryPromise({ try, catch: (cause) => new VendorError({ … }) })`.
- A client that resolves with `{ data, error }` instead of rejecting needs `error` checked inside `try` and thrown, or the failure becomes a success with `data: null`.
- **`await someEffect` type-checks and does nothing.** When a call site awaits an Effect and discards the result, TypeScript accepts it and the work never runs. When you change a function from returning a Promise to returning an Effect, grep every call site: the compiler only catches those that use the result.
- Effect's scheduler yields through `setImmediate`, so a bare `vi.useFakeTimers()` can stall an Effect that forks or sleeps. Fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`) and restore with `vi.useRealTimers()`.

## Testing Effect code

- Provide the service under test with `withXTest(effect)`, which runs the real `make` on the test layers below it. To drive one dependency, set its `xTestState`, and reset it in `beforeEach`.
- Run with `Effect.runPromise`, or `Effect.runSync` for code that never suspends. Assert a typed failure with `const error = await Effect.runPromise(Effect.flip(effect))`, then `expect(error).toBeInstanceOf(…)` or `toMatchObject(…)`: an unexpected success or a defect still rejects, so the test fails. Use `Effect.runPromiseExit` to assert a defect or a whole outcome.
- Which cases to write: [test-cases.md]({{rel:docs/conventions/test-cases.md}}).
