---
name: testing
description: Use BEFORE adding, writing, changing, fixing or deleting any test in this repo, even a single case or one regression test, and when a change alters or removes behaviour existing tests cover. Also use when asked "what should we test", "is this covered" or "why did this bug get through".
---

# Design the test cases

**Build the case table (step 4) before creating or editing a test file**, even for a single test.

**Rules:** [{{path:docs/conventions/test-cases.md}}]({{rel:docs/conventions/test-cases.md}}). Read it first; this procedure applies it.

## Procedure

1. **Read the requirement**: the issue and its spec when there is one, otherwise the user's request. Number every requirement and expected behaviour. Ask about the cases they leave open before going further.
2. **List the inputs the change reads**, and who controls each one (the browser, a third-party API, a webhook sender, an admin). For every field a client controls, write the honest value, a value that contradicts another field, and a value outside the accepted set (rule 5). For a parsed format, name the real samples needed and look for them in `__tests__/fixtures/` folders, creating one if none exists (rule 6).
3. **List the entry points and the tests already on them.** `rg` the changed function's callers up to the entry points: route handlers, loaders, commands, jobs (rule 10). Then `rg` the changed functions, services, shared test helpers and test doubles across the test files for every test that reaches them (rule 13).
4. **Build the case table** before opening the code's branches (rule 4):

    | #   | Case | Source | Expected | Level | Test | Action |
    | --- | ---- | ------ | -------- | ----- | ---- | ------ |

    `Source` is a requirement number, an input from step 2, an entry point from step 3, or the bug. `Expected` names the reason (the error class and message, or the invalid field's path), not only that it fails (rule 8). `Level` is `unit` or `e2e` (a browser against a running app); pick `e2e` only when the case needs a browser or a deployed site. `Test` is a `file:line` or `missing`. `Action` is `new`, `keep`, `update` or `delete`. Every test found in step 3 gets a row even when no requirement names it, and a `delete` names the change that removed the behaviour (rule 13).

5. **Drop the tautological, change-detector and low-signal tests** from the table (rules 1 to 3): a test whose assertion would pass against a stub, that checks how the code works instead of what it does, or that catches no bug another test in the table doesn't. A `keep` row for an existing test that fails these becomes `update` or `delete`. Check each fake the cases rely on: when it is a stub of the service under test rather than of a vendor below it, or it fakes the risk itself (rule 7), the case needs the real implementation over a vendor fake.
6. **For a bug fix**, mark the case that reproduces it. After writing it, run it against the pre-fix code in a temporary worktree, so the fix in your checkout is never touched: `git worktree add <tmp> <fix>^` (or `HEAD` while the fix is uncommitted), link `node_modules` into it, copy in the new test and any helper it added, run that test file there, then `git worktree remove <tmp>`. Keep the failure output for the PR (rule 11).
7. **Post the table plus a "Not covered" list** (each gap with its reason), then write the tests it lists. In plan mode, the table and the list go in the plan.

## After the tests are written

- For each negative case, disable the check it targets and confirm the test fails (rule 8). Restore the code afterwards and confirm `git diff` shows only the changes you meant to keep.
- Run the affected test files while iterating, and `pnpm test` at the end.
- Put the "Not covered" list under a `Not covered:` line in the PR description, one bullet per gap (rule 12).
- If the miss came from missing guidance, propose the change to `{{path:docs/conventions/test-cases.md}}` in the same PR (rule 11).
- Behaviour you found wrong while building the table (a silent accept, a lost error) is a finding for the user. Report it; never write a test that pins the wrong behaviour.
