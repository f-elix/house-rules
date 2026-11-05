# house-rules

Coding guardrails that repos vendor: lint rules, convention docs, agent skills, an AGENTS.md section, editor config, and CI. A repo installs a copy and owns it. Local edits are allowed, and updates merge upstream changes into them instead of overwriting them.

The model comes from [anti-slop](https://github.com/dmmulroy/anti-slop): vendored files, updated through a reviewed 3-way merge. house-rules adds a lockfile that records the upstream commit and a content hash for every managed file, so each update knows its merge base.

## Use it in a repo

Add the skill, then ask your agent to install house-rules:

```sh
npx skills add f-elix/house-rules --skill house-rules
```

`--skill house-rules` pins the install to that one skill. The skills CLI only lists `skills/house-rules` today, but when it finds no valid skill there it scans the whole repo and would offer the payload skills under `src/skills/` as well.

The skill runs a small bootstrap, `scripts/run.mjs`. It clones house-rules at the locked ref (default `main`) and runs that checkout's engine, so the engine always matches the payload it installs. You can also run it yourself:

```sh
node .agents/skills/house-rules/scripts/run.mjs install --dry-run
node .agents/skills/house-rules/scripts/run.mjs install
```

| Command          | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `install`        | Writes the modules' files. Stops without writing anything if an existing file would be replaced. |
| `update`         | 3-way merges upstream changes into the local copies. Leaves conflicts for review.                |
| `check`          | Compares the repo with the lockfile. Fails on missing files, conflict markers or pending work.   |
| `resolve <path>` | Marks a conflict as fixed once its markers are gone, or a manual change as made.                 |
| `untrack <path>` | Stops managing a path and leaves the file alone.                                                 |

Every command takes `--json` for a machine-readable report. Every command but `check`, which never writes, takes `--dry-run`: it writes nothing and reports the status and exit code the real run would have. The exit code is 0 when done, 1 when refused or failed, and 2 when conflicts or manual changes are pending. Run `node scripts/house-rules.mjs --help` for the full list. `--source` installs from a local checkout or a fork's URL, and the lockfile remembers it. The bootstrap clones a local checkout too, so only its commits count. A local path in the lockfile only works on that machine, so CI can't fetch it; the report says so.

### Install

Install plans every file first. If a target already exists with other content, it reports a collision and writes nothing. Rerun with `--overwrite`, `--keep` or `--skip` for each one. A kept file is tracked as a local change. Keeping another config for the same tool, or a link that points elsewhere, declines the item instead, as `--skip` does. A skipped path stays declined: later installs and updates leave out what upstream adds under it.

`--map docs=handbook` moves a folder. Paths inside the payload are templates, so links and references follow the move. The lockfile fixes the layout at the first install. Map `tools/oxlint` as a whole: `core.json` loads the plugin from `./anti-slop`, next to it, and install refuses a map that splits them.

Install doesn't touch `package.json`. It lists the devDependencies, scripts and fields the modules need, and you add them. The repo needs Node 22.18 or later, since oxlint loads the anti-slop plugin from TypeScript source through Node's type stripping.

### Update

For each managed file or block, update compares three versions: the base (upstream content at the locked commit), the local copy, and upstream at the new ref.

- Local copy unchanged: take upstream.
- Upstream unchanged: keep the local copy.
- Both changed: `git merge-file`. A clean merge is written; a conflict stays in the file as diff3 markers and in the lockfile under `pending`.

Values added to JSON files merge as a set: upstream's additions and removals apply, and the repo's own stay. A value upstream replaces takes the old one's place, so an `extends` entry keeps its precedence. A new value goes right after the modules' other values, or first in the array when there are none, so the repo's own values come after it. The engine writes JSON the way Prettier prints it with a 100-column line, keeping the file's indentation. A JSON file with comments gets a `manual` change instead, also pending until `resolve`.

The lockfile keeps the old commit until nothing is pending. New upstream files are reported and only installed with `--add`, except a file inside a folder or skill the repo already has, which comes with the update since the files beside it may import or link to it. Deleted upstream files are reported and only dropped with `untrack`. An upstream rename stops the update before it writes anything, since upstream's links already point at the new path. `--follow-renames` moves the local file, and `--keep <path>` leaves it where it is and adds a map to the lockfile, so payload links to the new path point at it. The update refuses `--keep` inside `tools/oxlint`, whose files load each other by relative paths. A rename counts even when upstream moved the file in one commit and rewrote it in a later one. Changes to the managed oxlint config are listed separately, each rule and category and every other top-level key, so the user approves each one. The skill's [update guide](skills/house-rules/references/update.md) walks an agent through it.

### Check

Add `check` to CI. The `core` module's workflow runs it. It fails on missing managed files, broken skill links, leftover conflict markers and pending conflicts. A locked commit behind its ref is a warning, or a failure with `--strict`. Local modifications are reported as information.

## The core module

| Payload                           | Installed at                            |
| --------------------------------- | --------------------------------------- |
| `src/lint/core.json`              | `tools/oxlint/core.json`                |
| `src/lint/anti-slop/`             | `tools/oxlint/anti-slop/`               |
| `src/conventions/*.md`            | `docs/conventions/`                     |
| `src/agents/docs/*.md`            | `docs/agents/`                          |
| `src/skills/<name>/`              | `.agents/skills/<name>/`                |
| `src/config/.editorconfig`        | `.editorconfig`                         |
| `src/ci/*.yaml`                   | `.github/workflows/`                    |
| `src/agents/core.md`              | a block in `AGENTS.md`                  |
| `src/conventions/readme/core.md`  | a block in `docs/conventions/README.md` |
| `src/config/.prettierignore.core` | a block in `.prettierignore`            |

Each skill also gets a relative symlink at `.claude/skills/<name>`. The repo's `.oxlintrc.json` gets `extends: ["./tools/oxlint/core.json"]` and ignore patterns for agent folders and the vendored plugin. Another oxlint config file (`.oxlintrc.jsonc`, `oxlint.config.ts` or `oxlint.config.mts`) counts as a collision with the `extends` value, since oxlint refuses to run with two config files. `--overwrite` installs the managed config anyway, and the report names the old config to delete.

Blocks sit between markers such as `<!-- house-rules:core:start -->` and `<!-- house-rules:core:end -->`. Text outside the markers belongs to the repo. A later module adds its own block after the last one.

### Oxlint `extends`

The repo's `.oxlintrc.json` stays the repo's own file and pulls the managed config in with `extends`. Tested with oxlint 1.81.0 and `@oxlint/plugins` 1.81.0:

- `rules`, `categories` and `jsPlugins` carry over. A plugin specifier resolves relative to the extended file, and `jsPlugins` from several extended files add up.
- `overrides` from both files apply. Their `files` globs match from the repo root.
- `ignorePatterns` in an extended file are ignored. That's why install adds them to the root config.
- A later `extends` entry overrides an earlier one, and the root config's own settings override both. Install puts its entries before the repo's own, so the repo's configs win.

If a later oxlint stops carrying `jsPlugins` or `overrides` through `extends`, copy `tools/oxlint/core.json` into `.oxlintrc.json`, change the plugin specifier to `./tools/oxlint/anti-slop/index.ts`, and run `untrack tools/oxlint/core.json .oxlintrc.json#extends#core`. The rest of the install still works.

## Other modules

Install them with `--modules`, for example `--modules effect,svelte,tailwind`. Each brings `core`.

| Module     | Payload                                                                  | Installed at        |
| ---------- | ------------------------------------------------------------------------ | ------------------- |
| `effect`   | `src/lint/effect.json`, `src/lint/house-effect/`                         | `tools/oxlint/`     |
|            | `src/conventions/effect.md`, `error-handling.md` and their `.details.md` | `docs/conventions/` |
| `svelte`   | `src/lint/svelte.json`, `src/lint/house-svelte/`                         | `tools/oxlint/`     |
|            | `src/conventions/svelte-components.md`                                   | `docs/conventions/` |
| `tailwind` | `src/conventions/styling.md`                                             | `docs/conventions/` |

Each adds its own table of topics to `docs/conventions/README.md`. `effect` and `svelte` add their oxlint config to `extends` after core's, and put their plugin folder in `ignorePatterns` and `.prettierignore`.

- `effect.json` turns on the vendored `anti-slop-effect` rules and `house-effect/no-instanceof-in-effect-error-handler`. That rule flags `instanceof` on an error class inside an Effect error handler, since tagged errors are told apart by tag. Built-in errors pass. List classes that share one tag on purpose in the rule's `allow` option.
- `svelte.json` turns on `house-svelte/no-underscore-exports` in `src/routes/`. SvelteKit accepts `_`-prefixed exports from route files, which makes them a back door for tests.

oxlint also lints the `<script>` of `.svelte` files, with every rule the configs turn on.

## The lockfile

`house-rules.lock.json` lives at the repo root. Commit it. It records:

- the source URL, ref and commit
- the installed modules and path maps
- each managed file and block: payload source, target, the commit its base comes from, and the base's hash
- skill links, values added to JSON files, and paths the repo declined
- pending conflicts and manual changes

## This repo

| Path                                      | Contents                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `modules.json`                            | Modules (files, skills, blocks, JSON values, requirements), and `hosts`: how to create the files that blocks and JSON values go in |
| `src/`                                    | The payload, copied into consuming repos                                                                                           |
| `scripts/house-rules.mjs`, `scripts/lib/` | The engine, Node built-ins only                                                                                                    |
| `skills/house-rules/`                     | The skill and its bootstrap                                                                                                        |
| `test/`                                   | End-to-end tests against temporary git repos                                                                                       |

Third-party content in `src/` has an `UPSTREAM.md` next to it with the source, commit, license and local changes.

Custom rules use the plugin prefix of their module: `house-effect`, `house-svelte`. `house` is reserved for custom rules in `core`, which has none yet.

### Develop

```sh
pnpm install
pnpm check    # lint, typecheck, tests
pnpm format
```

## License

MIT, Felix Guérin. Vendored content keeps its own license, next to it in `src/`.
