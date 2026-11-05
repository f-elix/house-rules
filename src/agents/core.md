## Research before building

Before writing a workaround, a custom plugin or a helper, check the upstream project: the latest version's changelog, its issue tracker, and the library's own primitives. Report what you found, even when it's nothing.

## Philosophy

This codebase follows John Ousterhout's _A Philosophy of Software Design_. Apply it to every change: architecture, interface design, refactors and bug fixes. The Philosophy section of `{{path:docs/conventions/README.md}}` names the skills that serve as its rubric.

## Code conventions

Before writing or reviewing code, open `{{path:docs/conventions/README.md}}` and read every topic whose **Applies to** matches the change.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `{{path:docs/agents/issue-tracker.md}}`.

### Triage labels

Triage uses the default canonical label strings. See `{{path:docs/agents/triage-labels.md}}`.

### Domain docs

`{{path:docs/agents/domain.md}}` says where `CONTEXT.md` and the ADRs live and when to read them.
