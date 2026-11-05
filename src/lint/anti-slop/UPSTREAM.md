# Upstream

Vendored copy of the anti-slop Oxlint plugins. house-rules ships it to consuming repos, which then own their copy: local changes are allowed and get reconciled on update.

- Source: https://github.com/dmmulroy/anti-slop
- Source path: `skills/install-anti-slop/assets/anti-slop`
- Source commit: `e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a` (committed 2026-09-10). The copied files, without `LICENSE` and this file, hash to git tree `a7831feb0c097943ac813ddcb1367e26eef52da5`, the tree at that path in that commit.
- License: MIT, Dillon Mulroy. `LICENSE` is the repository root license at the source commit.

## Plugins

- `anti-slop`: `index.ts`. The `core` module enables every rule at `"error"` in `../core.json`.
- `anti-slop-effect`: `effect/index.ts`. The `effect` module enables every rule at `"error"` in `../effect.json`.

`vendor/eslint-stylistic/` carries its own license and provenance (`vendor/eslint-stylistic/UPSTREAM.md`). That record is anti-slop's, kept as upstream wrote it: the sync script and tests it names belong to the anti-slop repository.

## Intentional deviations

- Added `LICENSE` from the upstream repository root. The source path doesn't include one.
- The upstream RuleTester suites live in the repository's `src/` tree, outside the source path, and aren't vendored.

The code itself matches the source commit byte for byte. Keep it out of Prettier (double quotes, mixed indentation) so diffs against upstream stay readable.
