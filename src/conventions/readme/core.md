A topic can be split in two files, and every rule lives in exactly one of them:

- **`<topic>.md`** holds what a reviewer can't catch on the diff: invariants, procedures, and behaviour that breaks silently. Read it before writing.
- **`<topic>.details.md`** holds what a reviewer can check on the diff: design quality, idioms, naming, wording, style. The reviewer reads it after `<topic>.md`.

When you add a rule, ask whether a reviewer holding it would spot a miss on the diff. If so, it goes in `<topic>.details.md`, even when fixing the miss means rewriting the code. Topics not split yet have a single file, read by both.

## Philosophy

The codebase follows John Ousterhout's _A Philosophy of Software Design_: the [`software-design-philosophy`]({{rel:.agents/skills/software-design-philosophy/SKILL.md}}) skill is the rubric, and [`codebase-design`]({{rel:.agents/skills/codebase-design/SKILL.md}}) gives the vocabulary for one module (module, interface, seam, adapter, depth). Where the two disagree on how depth is measured, `codebase-design`'s depth-as-leverage applies.

- **Consistency over personal preference**: we follow these patterns even if you'd do it differently.
- **Readability over cleverness**: code is read more than written.
- **Type safety**: let the type checker catch errors early.

## Topics

A reviewer loads every row whose **Applies to** matches the diff, in every table below.

| Topic             | Before writing                                 | Details                                      | Applies to                                                          |
| ----------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Comments          | [comments.md][core-comments]                   | [comments.details.md][core-comments-details] | Any export or comment in a source file, including lint suppressions |
| Testing           | [testing.md][core-testing]                     |                                              | Any test file                                                       |
| Test cases        | [test-cases.md][core-test-cases]               |                                              | Any test file                                                       |
| TypeScript        | [typescript.md][core-typescript]               |                                              | Any `.ts` file                                                      |
| File organization | [file-organization.md][core-file-organization] |                                              | A new module or file, import paths                                  |

[core-comments]: {{rel:docs/conventions/comments.md}}
[core-comments-details]: {{rel:docs/conventions/comments.details.md}}
[core-testing]: {{rel:docs/conventions/testing.md}}
[core-test-cases]: {{rel:docs/conventions/test-cases.md}}
[core-typescript]: {{rel:docs/conventions/typescript.md}}
[core-file-organization]: {{rel:docs/conventions/file-organization.md}}
