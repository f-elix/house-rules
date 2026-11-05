# Update house-rules

Adapted from anti-slop's update procedure ([dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), `skills/install-anti-slop/references/update.md`).

The repo owns its copy of house-rules. Local edits and local deletions are policy. An update is a reviewed merge: base (the upstream content the lockfile records), local (the repo's file) and incoming (upstream at the new ref). It never replaces the repo's choices with upstream defaults.

## 1. Protect local work

Run `git status`. The engine refuses to update while managed files have uncommitted changes, so a bad merge can always be undone with git. Ask the user to commit or set the changes aside. Pass `--allow-dirty` only if the user asks for it.

Settle the target: the locked ref (default), or another branch, tag or commit with `--ref`. The lockfile keeps the ref for later runs. A commit pins the repo: `check` then never reports it as `behind`, and later updates stay on that commit until one names another `--ref`.

Complete when managed files are clean and the target ref is known.

## 2. Preview

Run `update --dry-run --json`. It writes nothing and reports the status the real run would have: `refused` while a rename needs a decision, with every other change still listed. Then show the user:

- every entry in `lintChanges`: rules added, removed, or changed in severity or options (`rule`), changed `categories` (`category`), and any other top-level key of the oxlint config, such as `plugins`, `jsPlugins` or `overrides` (`setting`)
- `new` entries: files, skills or blocks upstream added to installed modules. A file upstream added inside a folder or skill the repo already has isn't `new`: the update writes it with the rest of the folder, and it shows as `written`.
- `deleted`, `renamed` and `collision` entries
- `requirementChanges`: devDependency versions and scripts upstream changed

Ask the user to approve each lint change and each new item, and whether each renamed file follows upstream. A request to update doesn't approve them.

Complete when the user has decided on every lint change, new item and rename.

## 3. Run the update

Run `update --json`. Add `--add <path>` for each approved new item and `--skip <path>` for each declined one. A skipped item comes back only when a later run names it with `--add`. For a renamed file, add `--follow-renames` to move it, or `--keep <old path>` to leave it. The update refuses and writes nothing while a rename has neither, since upstream's links already point at the new path. When an approved new item's path already holds a different file, the run reports a `collision`; ask the user, then rerun with `--add <path>` plus `--overwrite <path>` or `--keep <path>`.

The engine handles each managed file, block and JSON value:

| Status      | What happened                                                                                                         | What to do                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `written`   | Upstream added a file to a folder or skill the repo has, or an approved new item was installed.                       | Nothing.                                  |
| `adopted`   | An approved new item matched the file already at its path; the engine now manages it.                                 | Nothing.                                  |
| `skipped`   | `--skip` declined a new item. Later updates leave it out.                                                             | Nothing.                                  |
| `unchanged` | The local version already matches upstream.                                                                           | Nothing.                                  |
| `updated`   | No local change; took upstream.                                                                                       | Nothing.                                  |
| `kept`      | Upstream didn't change; the local version stays.                                                                      | Nothing.                                  |
| `merged`    | Both sides changed; `git merge-file` merged them.                                                                     | Review the result (step 4).               |
| `conflict`  | Both sides changed the same lines.                                                                                    | Resolve (step 5).                         |
| `no-base`   | The base couldn't be read; merged against nothing.                                                                    | Port by hand (step 5).                    |
| `manual`    | A JSON file has comments the engine would lose or isn't valid JSON, or the key isn't an array.                        | Make the change by hand (step 5).         |
| `renamed`   | Upstream moved the file. The run refused and wrote nothing.                                                           | Ask the user, then rerun (step 6).        |
| `collision` | A new or moved upstream file's path holds another file. A new item wasn't written; for a moved file, the run refused. | Ask the user (step 3 or 6).               |
| `moved`     | `--follow-renames` moved the file to upstream's new path.                                                             | Check links to the old path (step 6).     |
| `mapped`    | `--keep` left a moved file in place, and the lockfile maps the new path to it.                                        | Nothing.                                  |
| `removed`   | A skill folder moved, so its old `.claude/skills` link went with it.                                                  | Nothing; the new link is `written`.       |
| `deleted`   | Upstream dropped the file, block or JSON value.                                                                       | Ask the user (step 6).                    |
| `missing`   | A managed file is gone, or a block's host file or markers are missing or malformed.                                   | Ask the user (step 6).                    |
| `excluded`  | Upstream added a file under a path the repo untracked or skipped. It stays out.                                       | Ask the user; `--add <path>` installs it. |
| `held`      | A new JSON value names a file the repo doesn't have yet, such as a new config still waiting as `new`. It stays out.   | Nothing; it goes in once the file does.   |

Complete when the status is `updated`, `up-to-date` or `pending`.

## 4. Review merges

A merge without conflict markers isn't proof the result works. For each `merged` entry, diff it against the last commit. Check that local changes to predicates, exceptions, options, severities and wording survived, and that upstream's change still makes sense next to them.

Complete when every merged file has been read and either accepted or fixed.

## 5. Resolve pending work

Conflicts are left in the files as diff3 markers: `<<<<<<< local`, `||||||| base`, `=======`, `>>>>>>> incoming`. The lockfile lists each conflict and manual change under `pending` and keeps the old base, so nothing claims the new commit until it's resolved. The report's status stays `pending` until then.

- **`conflict`:** compare both sides against the base. Keep local policy and take upstream fixes. When the two disagree on policy or behaviour, ask the user. Never pick a side silently.
- **`no-base`:** without a base, a diff can't tell a local customization from an upstream change. The base section is empty. Keep local behaviour, and port only the upstream changes whose purpose you understand. Ask about any difference whose intent is unclear.
- **`manual`:** edit the JSON file as `detail` says and keep its comments. Fix invalid JSON first. A value the repo removed on purpose stays removed.

Then run `resolve <path>`. It refuses while markers remain. Once nothing is pending, the lockfile moves to the new commit.

Complete when `pending` is empty in `house-rules.lock.json`.

## 6. Deleted, missing and renamed

- **Upstream deleted:** ask whether to keep the local file or retire it. Delete it only if the user agrees. Either way, run `untrack <path>`.
- **Local file missing:** check `git log` for whether the deletion was deliberate. A deliberate deletion is policy: run `untrack <path>` to keep it deleted. Otherwise restore the file from git and run `update` again. For a block, `detail` says whether its markers are gone or malformed. Fix a lone, repeated or out-of-order marker by hand, keeping one start and one end marker, then run `update` again. Never `untrack` a block only because its markers broke, since it would stop getting updates.
- **Renamed:** the update refused until each move is settled. Ask whether the file moves. `--follow-renames` moves it, and a skill's `.claude/skills` link follows its folder. `--keep <old path>` leaves it and maps the new path to it, so payload links still reach it. Then check the repo's own links to the old path.
- **Collision:** a moved file's new path is taken by another file. Ask the user to clear that path and rerun with `--follow-renames`, or rerun with `--keep <old path>`. For a new item, see step 3.

Complete when no `deleted`, `missing`, `renamed` or `collision` entry is left unanswered.

## 7. Lint changes and requirements

- **Declined lint change:** revert it in the local oxlint config (`tools/oxlint/core.json` by default). The engine keeps that edit through later updates. A rule the repo turned off stays off.
- **Approved new rule that fails on existing code:** report the findings. Fix them only if the user asks. Never weaken a rule or add a suppression to make lint pass.
- **Requirements:** apply `requirementChanges` and the `requirements` still missing with the repo's package manager. Keep `oxlint` and `@oxlint/plugins` on the same exact version, and leave unrelated dependency ranges alone.

Complete when the oxlint config matches the user's decisions and package.json meets the requirements.

## 8. Verify and hand back

The anti-slop plugin folder (`tools/oxlint/anti-slop/` by default) is lint-ignored and ships without its tests. When an entry under it is `merged`, `updated` or `written`, write a scratch file with code each changed rule should reject and code it should accept, run oxlint on it with the repo's config, then delete it. Show the user every case where a local customization changes the result.

Run the repo's formatter on the changed files, then lint, typecheck and tests. Report findings in the repo's own code separately from house-rules problems. Then run `check --json`.

Report to the user:

- the commit range (`source.from` to `source.commit`)
- the upstream changes applied
- the local changes kept
- the decisions still open

They review the diff and commit, including `house-rules.lock.json`.

Complete when `check` passes and the user has the report.
