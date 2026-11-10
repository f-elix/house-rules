# Effect — details

Read [effect.md]({{rel:docs/conventions/effect.md}}) first. Adapted from the Effect sections of the [cf-workflow-pool coding standards](https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/coding-standards.md#effect-imports).

## Imports

Import Effect modules as named exports from the package root, several in one declaration:

```ts
import { Context, Effect, Layer, Schema } from 'effect';
```

No leaf-module imports (`from 'effect/Effect'`, `import * as Effect from 'effect/Effect'`). No lint rule enforces this yet. An unstable module comes from its narrowest public entry point under `effect/unstable/…`. Tests import the same way.

## Generators and pipes

Write a workflow with `Effect.gen` and `yield*`: retrieving services, dependent steps, named intermediate results, branching, loops, early returns. Keep those decisions visible as ordinary control flow.

| What                                                                                        | How                                                      |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Retrieving services, sequential steps, business conditions                                  | `Effect.gen`, or `Effect.fn`                             |
| Error translation and recovery, retry, timeout, log annotations, providing services, layers | `.pipe(...)`, or `Effect.fn`'s whole-function transforms |
| One pure transform of the result                                                            | `.pipe(Effect.map(...))`; no generator for it            |
| Several dependent `map` / `flatMap` / `andThen` steps                                       | A generator, so the intermediate values have names       |

Inside a generator, a yielded Effect may pipe a local error translation or a simple transform. Once that pipe starts running other Effects or branching on domain outcomes, move the logic into the surrounding generator.

## `Effect.fn`

`Effect.fn` is optional. Its name becomes a span, which pays off only when the repo exports traces. A service operation that takes no arguments is a plain Effect built with `Effect.gen`. One that takes arguments can be an arrow that returns `Effect.gen`, or an `Effect.fn` when you want its whole-function transforms. Write the operations of one service the same way. A type annotation on an `Effect.fn` result uses `Effect.fn.Return<A, E, R>`.

When you use `Effect.fn`, pass transforms that apply to the whole method straight after the generator, as pipeables:

```ts
const scheduleFollowUp = Effect.fn('Onboarding.scheduleFollowUp')(
	function* (input: { readonly customerId: string; readonly email: string }) {
		// …
	},
	Effect.catch((error) => Effect.logError('Follow-up scheduling failed', error))
);
```

Pass each transform as its own argument after the generator; one that needs the method's arguments takes them as extra parameters, `(effect, input) => …`.

## Services

- Callers `yield* X` and leave `X` in their requirements; only the boundary (through `withX`) or a test provides it. Don't pass a service as a plain argument.
- The service id is the class name. It identifies the service at runtime, so keep it unique across the app.
- Build an implementation outside `make`, such as an in-memory fake, with `X.of({ … })`, so it is checked against `XApi` too.
- A layer yields the services it needs while it's built. Don't yield a service in an outer Effect only to hand it to a `makeXLayer(service)` factory. Plain arguments stay right for request or domain values and for constructor options.

## Naming

- Every exported symbol carries the capability name (`PlanCatalog`, `planCatalogTestState`, `withPlanCatalog`), rather than relying on its file path for context.
- No `Tag` in names. The `Service` suffix is optional: use the shortest name that says what the service is responsible for (`CartRepository`, `ReceiptMailer`), and use it consistently on the service, its layers and its `withX` helper.

## Gotchas

- `yield*` an Effect-returning function directly. Wrapping it in `Effect.promise(() => Effect.runPromise(fn()))` loses its error channel and the services around it.
- No `async`/`await` inside `Effect.gen`: wrap the Promise with `Effect.promise` or `Effect.tryPromise`.
- An `Option` is not an Effect. Use `yield* Effect.fromOption(option)` (fails with `NoSuchElementError`), or `Option.gen` when the computation stays in `Option`.
