# Choosing test cases

This page is about which cases to write. Where tests live is in [testing.md]({{rel:docs/conventions/testing.md}}).

Rules 1 to 3 apply to every test, existing or new. Rules 4 to 13 decide which cases a change needs. The `testing` skill runs this page as a procedure before any test is written ([SKILL.md]({{rel:.agents/skills/testing/SKILL.md}})).

## Rules

### 1. No tautological tests

A tautological test passes without exercising the code under test: it asserts a value produced directly by setup or a fake, or compares a constant against itself. Ask of every assertion: if the code under test were replaced by a stub returning a fixed or empty value, would this fail? If not, it checks the test, not the code. Rule 8 is the same question asked by breaking the code.

```ts
// ❌ the fake catalog returns its state as-is: this asserts what setup put there
const catalog = createFakePlanCatalog({ publicPlans });
const result = await catalog.listPublicPlans();

expect(result).toEqual(publicPlans);

// ✅ the real cart logic runs over an in-memory KV store: this asserts what it decided
const carts = createCartService(createInMemoryKvStore());

await carts.addLine('cart-1', product({ uid: 'u1', qty: 2 }));

const cart = await carts.setLineQty('cart-1', 'u1', 5);

expect(cart.itemsCount).toBe(5);
```

A test double that replaces the service's own logic makes every test of that service tautological. Fake the vendor below it instead.

### 2. Test the behaviour, not the implementation

A test pinned to the implementation is a change-detector: it fails on every refactor and on no bug. Assert what a caller or a user can observe: the returned value or error, the redirect, the rows in a fake's state, the email a fake mailer received, what the page shows. Leave out which internal function ran, in what order, with which arguments, and what intermediate state looked like. A refactor that keeps the behaviour keeps the test green. Call assertions (`toHaveBeenCalledWith`) belong at the edges only: a request to the payment provider, an email handed to the mail service, a report sent to error tracking.

### 3. No low-signal tests

Before writing a test, name the bug it would catch that no other test catches. No answer means no test. Low-signal tests cost a run and a maintenance edit forever and prove nothing:

- what the compiler already checks: types, a field set by a constructor, a re-export;
- an assertion that passes for almost any result, such as `toBeDefined()` alone when the value itself is the behaviour;
- library or framework behaviour: that a schema's number field rejects a string, that a framework's reactive value updates;
- a second test of the same failure mode at another level, with nothing new to prove;
- a test written to raise coverage rather than to pin a behaviour.

### 4. Build the case list from the requirement and the real input, then read the code

A test written by reading the code checks the branches the code has. A case the code never thought of has no branch, so it never gets a test. Partition the input by what the outside world can send, and use the code only to find where each partition lands.

### 5. Anything the client sends can lie

The browser picks the file name, the declared MIME type, the size, the ids, the quantities and any hidden field. For each field the change reads, the list has the honest value, a value that contradicts another field (the bytes versus the declared type, a product id that doesn't match the chosen option), and a value outside the accepted set. Expect more negative cases than positive ones.

_For example:_ a cart form whose `qty` field accepts any number gets a normal quantity, `0`, a negative number, a fraction and a very large number. An uploaded avatar is checked for size; its list also has a file whose bytes aren't an image.

### 6. Code that parses a format gets real samples

Images, PDFs, CSV, vendor payloads and webhook bodies are tested with real samples committed as small fixtures in a `__tests__/fixtures/` folder next to the test (create it if the module has none yet), including the kind our users' devices produce (an iPhone HEIC photo). Hand-written bytes and hand-typed payloads only test what we believe the format looks like. A fixture folder has a README saying where each file came from.

### 7. Don't mock the risk

Fake what is slow, outside our control or has side effects: the database, third-party APIs, the mail service, error tracking, the clock. Keep real anything whose output is what can go wrong: our schemas and their messages, date calculations across time zones, price and tax arithmetic, our own modules. A test that mocks the risk proves the call was made and nothing about its result.

### 8. Assert the reason, then break the code to prove it

A negative test that checks only that the call failed passes when the input is refused for any reason. Assert the error class and the message, or the path of the invalid field for a validation error. Then disable the check the test is about and watch the test fail. If it stays green, it is testing another check.

### 9. Every requirement gets a test or a written reason

Walk the issue's requirements one by one (the issue and its spec, or the request itself). Each gets a test, or a line in the PR saying why it has none.

### 10. Same logic, every entry point

When a shared function serves several entry points, each entry point gets at least one case per rejection family: one reason the input can be refused, so one error. An entry point can skip the shared check, call it after a side effect, or translate its error differently.

_For example:_ three forms (sign-up, upgrade, gift) start a checkout through the same `startCheckout`, over two schemas.

### 11. An escaped bug fixes its class

The fix PR carries a regression test run against the pre-fix code, with its failure quoted in the PR. It also covers the other members of the class: other lies about the same input, other entry points over the same code. When the miss came from missing guidance, the same PR changes this page, a skill or a lint rule.

### 12. The PR says what the tests do not prove

The PR lists what stays uncovered under a `Not covered:` line, one bullet per gap with its reason (needs a real payment, needs a real device, vendor behaviour faked). A test count gives the reviewer nothing to weigh. A named gap does.

### 13. Start from the tests that already exist

Most changes touch behaviour that is already tested, so the case list also covers the tests in place. Find every test that reaches the changed code or behaviour, including those that get there through a shared test helper, a test double or an end-to-end page list. Each one gets a row and a verdict: keep it when it still holds, update it when the expected result changed, delete it when the behaviour is gone on purpose, naming the change that removed it. A test whose file disappeared follows its behaviour: when the behaviour moved, the test moves with it. A red test starts with the same question, whether what it checks still exists.
