# Upstream

Vendored copy of the `codebase-design` skill.

- Source: https://github.com/mattpocock/skills
- Source path: `skills/engineering/codebase-design/`
- Source commit: `59db609eb1e18aaf59b63284d0e52255aff0c63c` (2026-10-27). `SKILL.md`, `DEEPENING.md` and `DESIGN-IT-TWICE.md` match that commit's blobs before the formatting below.
- License: MIT, Matt Pocock. `LICENSE` is the repository root license; the skill folder has none.

## Intentional deviations

- `SKILL.md` and `DEEPENING.md` are formatted with Prettier 3.9.6 and the house-rules `.prettierrc`, so a consuming repo's `format:check` passes. `DESIGN-IT-TWICE.md` was already formatted.
- `agents/openai.yaml`, Codex display metadata, isn't vendored.
