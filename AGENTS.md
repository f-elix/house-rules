# AGENTS.md

house-rules ships guardrails that other repos vendor. `README.md` explains the model; read it before changing the engine or `modules.json`.

## Payload

- `src/` is the canonical payload. Everything in it lands in other repos, so keep it generic: a rule, doc or skill that names one project, product or domain belongs in that project's repo.
- A payload path written as `{{path:X}}` or `{{rel:X}}` renders to X's installed location, where X is the default target. Use them for every reference to another installed file, so `--map` keeps links working. The exception is a file that can't hold templates, such as `src/lint/core.json`, which this repo's own lint config extends as it is. It refers to a sibling by a plain relative path, so its module lists the folder holding both under `keepTogether`, and install and update refuse maps that split that folder.
- A devDependency or script that only some payload files need goes under the module's `serves`: its name, then the default targets of the files that need it. Install and update stop listing it once the repo tracks none of those files, for example when the repo keeps its own Prettier config.
- Vendored content keeps an `UPSTREAM.md` with source, commit, license and every local deviation. Update it in the same change as the content. Vendored prose stays as upstream wrote it, em dashes included, so later upstream changes merge cleanly; formatting is the usual deviation.
- A file that takes blocks or JSON values has one entry in `hosts` in `modules.json`, with its block style, scaffold and the other configs for the same tool. Every module that writes to the file shares that entry.
- The payload ships no Prettier config: the repo keeps its own. Payload text is formatted with this repo's `.prettierrc`, so a repo with the same settings installs it already formatted.
- A module comes after the modules it requires in `modules.json`. Installs follow that order, so a module's oxlint config lands later in `extends` and overrides the ones it builds on.
- The engine reads `modules.json` at a repo's locked commit as well as at the new one, so it must decode every past version. Add keys as optional, and keep existing keys' names and meaning.
- A file added to `modules.json` reaches existing installs as a `new` item, a file added inside a shipped folder or skill arrives with the update, and a moved payload file arrives as a rename (git's rename detection). Git detects renames commit by commit, and a move plus a large edit in one commit reads as a delete and an add. Move a file in a commit of its own, then edit it.

## Engine

- `scripts/house-rules.mjs` and `scripts/lib/` run from a fresh clone with no `npm install`. Use Node built-ins and `git` only.
- They're JSDoc-typed `.mjs` with `// @ts-check`; `tsc` checks them.
- `skills/house-rules/scripts/run.mjs` is installed separately and may run against an older or newer engine. Keep it standalone and its argument pass-through unchanged.
- The bootstrap and the core CI workflow (`src/ci/format-lint-check.yaml`) read the lockfile's `source.url` and `source.ref` before any engine runs. Keep those two fields' names and meaning in every lockfile version.
- Lockfile hashes cover rendered payload text: `render()` in `scripts/lib/render.mjs`, plus `normalizeBlock()` for blocks. The engine re-renders old bases with its own code and trusts a base only when its hash matches, so a change to that output turns every locally edited templated file into a `no-base` merge. A lockfile migration can't fix that, since it can't re-render. Keep the output stable. If it has to change, keep the old renderer and have the `readBase` callbacks that `reconcile()` in `scripts/lib/update.mjs` receives fall back to it when the current one misses the hash.
- A change to the lockfile shape bumps `LOCK_VERSION` in `scripts/lib/lock.mjs` and adds a step to `MIGRATIONS`, so older lockfiles still load.

## Lint

The root `.oxlintrc.json` extends `src/lint/core.json`, so the repo lints itself with the config it ships. Custom rules go in a plugin with the prefix of their module: `house`, `house-effect` or `house-svelte`. Those plugins live in `src/lint/house-*/`, which this repo lints and type-checks; the vendored `src/lint/anti-slop/` gets neither. A module that adds a plugin also adds its folder to `ignorePatterns` and `.prettierignore`, since the consumer's own lint and Prettier settings may differ from these.

## Verify

Run `pnpm check` (lint, typecheck, tests) and `pnpm format`. Tests run the CLI end to end against temporary git repos; add a case there for each engine behaviour you change. They live in `test/`, not in `__tests__` folders as `src/conventions/testing.md` asks, because they test the CLI as a whole rather than one module.
