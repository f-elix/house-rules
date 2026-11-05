# Upstream

`issue-tracker.md`, `triage-labels.md` and `domain.md` are output templates of the `setup-matt-pocock-skills` skill, which writes them into a repo's `docs/agents/`. They configure that collection's engineering skills (`triage`, `to-tickets`, `grill-with-docs` and others) for a repo.

- Source: https://github.com/mattpocock/skills
- Source path: `skills/engineering/setup-matt-pocock-skills/`, files `issue-tracker-local.md` (shipped as `issue-tracker.md`), `triage-labels.md` and `domain.md`
- Source commit: `3bb0b1b917b25c3c413c5d9df3df7fcfbb34e7ba` (2026-05-07). All three files match it byte for byte.
- License: MIT, Matt Pocock. `LICENSE` here is the repository root license. It stays in house-rules and isn't installed, since the setup skill writes these files into repos without a notice.

## Intentional deviations

None.

## Upstream changes not taken

The latest templates (`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`) rename the PRD to a spec, require one file per ticket, add a "Wayfinding operations" section for `/wayfinder`, and point `domain.md` at `/domain-modeling`. Take them together with the matching skill versions.
