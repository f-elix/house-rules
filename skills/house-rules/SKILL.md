---
name: house-rules
description: Install, update or check the house-rules guardrails vendored into a repo (oxlint config, conventions, skills, the AGENTS.md block, Prettier, CI). Use when adding house-rules to a repo, pulling its upstream changes, resolving a house-rules conflict, or when `house-rules check` fails.
---

# House rules

House-rules content is vendored: the repo owns its copy, and a local edit is policy, not drift. `house-rules.lock.json` records the upstream commit and content hash of every managed file and block, so an update is a 3-way merge against a known base.

Run every command through the bootstrap. It fetches house-rules at the locked ref (default `main`) and runs that checkout's engine on the repo:

```sh
node <skill-dir>/scripts/run.mjs <command> --json [options]
```

The `--json` report has a `status`, one entry per managed path (`status`, `target`, `detail`), `lintChanges`, `requirementChanges`, `requirements` (what package.json still lacks) and `next`, the steps left to you. The exit status is 0 when done, 1 when refused or failed, and 2 when the status is `pending`: conflicts or manual changes are left to resolve. A `--dry-run` writes nothing, sets `dryRun` to true, and reports the status and exit status the real run would have.

The bootstrap fetches house-rules on every run, `check --offline` included. When it can't fetch the source, or the lockfile has no readable `source`, it exits 1 and prints no JSON. Its stderr starts with a `house-rules:` line, followed by git's error when a fetch failed. Show the user that output.

Path arguments match a file, a folder and everything under it, `<file>#<module>` for a managed block, or `<file>#<key>#<module>` for the values a module adds to a JSON file.

## Install

1. Run `install --dry-run --json`. `--modules <a,b>` picks modules from house-rules' `modules.json` (default `core`). A module brings the ones it requires. To relocate a folder, add `--map tools/oxlint=config/oxlint`. Maps apply to the first install only, and the lockfile keeps them.

    Complete when the report has `dryRun: true` and the status is `installed`, `pending` or `collisions`. On `up-to-date`, `refused` or `error`, show the user `next` and stop.

2. For every `collision` entry, ask the user what to do with the existing file, then pass the answer on the next run:
    - `--overwrite <path>` takes the upstream file. When the existing file is another config for the same tool, such as `oxlint.config.ts`, the report's `next` names the config to delete.
    - `--keep <path>` keeps the local file and tracks it as a local change, which later updates merge into. When the existing file is another config for the same tool, or a link that points elsewhere, `--keep` leaves the item out like `--skip`, since there's nothing of upstream's to merge into.
    - `--skip <path>` leaves it out. Later installs and updates also leave out what upstream adds under that path, until an update names it with `--add`. Skip `tools/oxlint` whole or not at all: its files load each other, so the engine refuses a skip of part of it.

    Rerun the dry run until no collision is left.

3. Run `install --json` with the same options. Complete when the status is `installed`, or `pending` with only `manual` entries left for step 4.

4. Work through the report:
    - For each `manual` entry, make the change its `detail` names by hand, then run `resolve <path>`. The engine doesn't rewrite JSON files that have comments.
    - Install every `devDependency` under `requirements` with the repo's package manager, at the version shown. Keep `oxlint` and `@oxlint/plugins` on the same exact version.
    - Add every missing `script` and `prerequisite`. The CI workflows run `format:check`, `lint`, `check` and `test`.
    - Make sure the repo runs Node 22.18 or later, locally and in `.nvmrc`. oxlint loads the anti-slop plugin from TypeScript source through Node's type stripping, which older versions lack.
    - Tell the user about each `held` entry: a JSON value, such as an `extends` path, that names a file the repo doesn't have, usually because `--skip` left it out. Its `detail` says how the value goes in.

    Complete when no `manual` entry is pending and `install --dry-run --json` reports an empty `requirements` list.

5. Run the repo's formatter on the changed files, then its lint, typecheck and tests. Report lint findings in existing code to the user. Fix them only if the user asks. Complete when every check passes or each failure is reported.

6. Run `check --json`. Complete when the status is `ok` or `warnings`. Show the user the diff and `house-rules.lock.json`. They commit.

## Update

Read [references/update.md](references/update.md) and follow it. It covers merging, conflicts, manual changes, new, deleted and renamed upstream files, and lint changes that need the user's approval.

## Check

`check --json` compares the repo with the lockfile and makes no changes. CI runs it too.

- **Fails on:** `missing` (a managed file, block or JSON file is gone), `occupied`, `malformed` block markers, `markers` (conflict markers left in), `broken-link` (a `.claude/skills` link), `invalid` JSON and `pending` (a conflict or manual change not resolved yet).
- **Warns on:** `behind` (the locked commit is behind the ref), `diverged`, `unknown-ref` and `unreachable`. `--strict` turns warnings into failures. `--offline` skips the comparison with the ref. A repo updated with `--ref <commit>` is pinned to that commit, so it's never `behind`.
- **Reports as information:** `modified`, a local change to a managed file. That's expected, since the repo owns its copy.

To repair a missing file or `.claude/skills` link, restore it from git with `git restore <path>`. When the deletion was deliberate, run `untrack <path>`. The engine stops managing the path, and updates offer it again only when `--add` names it.

## Other commands

- `resolve <path>...` marks a conflict as fixed once its markers are gone, or a manual change as made. See the update reference.
- `untrack <path>...` stops managing a path and leaves the file as it is.
- `--source <path or git URL>` installs from another checkout or fork. The lockfile records it, and later commands use it.
