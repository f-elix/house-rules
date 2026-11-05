# Upstream

Vendored copy of the `software-design-philosophy` skill.

- Source: https://github.com/luoling8192/software-design-philosophy-skill
- Source path: `SKILL.md` and `LICENSE` at the repository root
- Source commit: `1a93214d65ea43b9a9f193fcc67ef4ba647a9422` (2026-07-11). `SKILL.md` is unchanged since `e55ac385e89913a6d53c7da460d080982d32ea03`.
- License: MIT, luoling8192. `LICENSE` matches upstream byte for byte.

## Intentional deviations

- `SKILL.md` is formatted with Prettier 3.9.6 and the house-rules `.prettierrc`, so a consuming repo's `format:check` passes. Formatting re-indents the frontmatter description and nested lists with tabs, turns `*emphasis*` into `_emphasis_`, adds blank lines around headings and lists, and aligns the Red Flags table.
- `codex-skill.md` and the README aren't vendored.
