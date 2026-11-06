# Comment details

Read [comments.md]({{rel:docs/conventions/comments.md}}) first. These rules follow the comment principles of the [`software-design-philosophy`]({{rel:.agents/skills/software-design-philosophy/SKILL.md}}) skill. The JSDoc rules are adapted from the [cf-workflow-pool coding standards](https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/coding-standards.md#comments-and-jsdoc).

A comment carries what the code can't: the abstraction a caller relies on, and the reasons behind an implementation. There are two kinds, held to different bars.

## Interface comments (JSDoc)

### Which symbols

- Every exported symbol, except those whose contract something else defines: the entry points a framework calls by name (route handlers, loaders, config default exports), message catalogs, and generated files.
- Every member of an exported service or interface type: the operations callers reach through it.
- The public methods and properties of an exported class.
- The fields of an exported object type whose meaning goes beyond their name and type.
- Private code, when maintaining it safely depends on a purpose, invariant, domain rule, side effect or trade-off that isn't visible.

In review, check the symbols a diff adds, and the existing ones whose signature or behaviour it changes. An undocumented export the diff doesn't touch is not a finding.

### What they say

Write from the caller's side: what the symbol does and what the caller can count on. One sentence is enough when it states the most important fact the signature can't show. Add more only for constraints, expected failures, side effects, invariants, trade-offs or domain rules. How the body works stays out: a caller who needs it to use the symbol is looking at a leaky interface.

When the comment has to be long to be complete, the interface is too complex. Fix the design rather than shortening the comment.

Document a symbol once, at its original declaration. Re-exports rely on it.

### Tags

Add a tag only when it tells the caller something the signature doesn't:

- `@param` for a constraint, unit or meaning the type can't carry (cents or dollars, a vendor's id or ours).
- `@returns` for what the value means, and which expected failures it can end in and when.
- `@throws` for an error the code throws, or a promise rejects with, by design and a caller is expected to handle. A failure the return type already carries belongs in `@returns`.

```ts
/** Stores sessions by id. Each expires {@link SESSION_MAX_AGE_SECONDS} after its last write. */
export type SessionStore = {
	/**
	 * @returns The session stored under `id`, or `null` when there is none, it expired, or it no
	 *   longer decodes.
	 * @throws {StoreUnavailableError} When the store can't be reached.
	 */
	readonly getById: (id: string) => Promise<Session | null>;
};

/** Where the payment provider sends the buyer after checkout. */
export type CheckoutRedirects = {
	readonly language: Language;
	readonly origin: string;
	/** A path on this site; `origin` is prepended to it. */
	readonly successUrl: string;
	/** An absolute URL, used as-is. */
	readonly cancelUrl: string;
};
```

`language` and `origin` need no comment: their names and types say it all.

## Implementation comments

### Try these before writing one

- Rename the variable or function so the comment becomes redundant.
- Extract the confusing block into a named helper.
- Encode the invariant in a type, a schema, or an assertion.

If one of these works, do that instead. It removes the question rather than answering it.

### Where one is warranted

- **External constraints** the code can't show: a vendor's rate limit, an undocumented vendor behaviour, a legal rule.
- **Workarounds** for a bug in a dependency, where the obvious code would be correct but doesn't work.
- **Required ordering** that isn't visible from the call sequence.
- **A deliberate deviation** from the obvious approach, where the obvious one is wrong.
- **A decision that spans modules**, written once where it is owned; elsewhere, only a pointer to it where a reader would otherwise break it.
- **Dense expressions** that resist naming: a non-trivial regex, a date calculation across time zones.
- **A complex block** whose overall effect takes real effort to work out: say what it does as a whole.

### Where it isn't

- Restating the line below it.
- Narrating what a function does when the name already says it.
- Teaching the language, the framework or a library: assume a competent reader.
- Section banners in ordinary source files.
- Commented-out code: delete it, git has it.
- `TODO` / `FIXME`: a marker in the source is an issue nobody triages. Raise it in your reply instead, so a human can file it in the issue tracker.

## Vocabulary

Comments, JSDoc and names use lasting words suited to their reader. When the domain phrase a reader would search for differs from the identifier, use the phrase: the terms in the repo's glossary, if it has one, come first. Issue names, migration phases, framework mechanics and planning language belong in issues and PRs, not in a comment.

## What a comment must not contain

A comment is read by someone with the file open and nothing else. Anything needing a browser tab, a git client or tribal memory to resolve is noise the moment it ages.

| Don't write                                     | Why                                                  |
| ----------------------------------------------- | ---------------------------------------------------- |
| `see #209`, `fixes ISSUE-42`                    | The PR or issue is where that context lives          |
| `changed in a1b2c3d`, `per the last diff`       | `git log` / `git blame` answer this, and correctly   |
| `previously this used a Map`, `used to be sync` | The old code is gone; describing it confuses readers |
| `as discussed with the client`, `per review`    | Unverifiable and meaningless in six months           |
| `added 2026-08-07`, `@author jane`              | Version control owns dates and authorship            |

Strip the reference and keep the sentence only if it still says something alone. Usually it doesn't: delete the whole comment. Markdown under `docs/` is the opposite case: prose and references belong there.

```ts
// ❌ #187: retry because the CMS timed out on the preview deploy
// ✅ The CMS's GraphQL endpoint drops the first request after a cold start; one retry clears it.

// ❌ We used to sort here but the repository sorts now
// ✅ (delete: the code no longer sorts, so nothing needs saying)

// ❌ Increment the counter
counter += 1;
// ✅ (delete: it restates the line)
```

## How it should read

An implementation comment sits at a higher level than the code: what a block achieves and why it's done this way, in fewer words than reading the block would take. Most code needs none.

- Inline comments: a line or two. If one grows past that, the code underneath probably wants extracting.
- JSDoc tags run as long as they need; keep the prose description tight.
- Plain declarative sentences. No preamble ("Note that…"), no hedging, no rhetorical questions.
- No headings, bullet lists or ASCII art inside an inline comment.
- In English, whatever the language of the page.

## Directives are not comments

`// oxlint-disable-next-line …`, `// eslint-disable-next-line …`, `// @ts-expect-error` and `// prettier-ignore` are code. Add them when needed. A suppression gets a one-line reason, held to the rules above.

## Editing comments that are already there

- **Accurate**: leave it alone.
- **Now wrong**: fix it to the rules above.
- **Now pointless**: delete it.
- **Carries an issue number or history**: strip it while you're there.

Clean up comments in files the change already touches, and keep it to those files so the diff stays reviewable.

`// Arrange` / `// Act` / `// Assert` and section banners may be extended in a file that already uses them. Don't introduce either into a file that doesn't.
