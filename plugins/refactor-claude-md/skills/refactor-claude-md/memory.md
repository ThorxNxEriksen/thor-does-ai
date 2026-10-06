# Memory — refactor-claude-md

Rulings the user has already made. Read before asking anything; append after every ruling.
One line per entry. Newest at the bottom of its section. Delete an entry only when the user
reverses it.

Format: `- <YYYY-MM-DD> <repo or path> — <ruling>`

## Contradiction rulings

How the user resolved competing instructions. Apply the same ruling to the same conflict
instead of re-asking.

- 2026-08-24 nn-nbx — "tokens only" vs "the dead txt-16/20/24 classes are the current intent"
  was NOT a live contradiction: commit 1f2a4e8 had already settled it (a whole-site typography
  sweep was tried, then reverted). Run `git log -S` on the competing lines BEFORE asking — a
  conflict already resolved in a commit message is not the user's to re-decide.
- 2026-08-24 nn-nbx — when a conflict is technical, this user wants implications before options.
  Measure first (how many call sites, what the library actually defines), show that, then ask.

## Stays in root

Instructions the user insisted belong in the root `CLAUDE.md` even though the essentials test
would move them out. Do not propose moving these again.

_(none yet)_

## Deletions rejected

Lines flagged for deletion that the user kept. Do not flag them again.

_(none yet)_

## Grouping preferences

File names and boundaries the user chose, so later runs land on the same structure.

- 2026-08-24 nn-nbx — one `docs/notion.md` holds BOTH the plumbing (config.ts, file URLs,
  transcription, redact.ts) and the editorial rules (HCP data, value-case caveat, empty
  blocks). Do not re-propose splitting plumbing from content.
- 2026-08-24 nn-nbx — the no-HCP-data rule lives in `docs/notion.md`, NOT root; root flags it
  on the link line only. User chose this over keeping it in root.
- 2026-08-24 nn-nbx — where a topic doc already exists (`working-fast.md`), root collapses to a
  single pointer rather than keeping a summary. No duplicated prose in root.
- 2026-08-24 nn-nbx — structure landed on: root + docs/{design-system,notion,deployment,
  working-fast}.md. Root links carry a "read before X" when-clause.
