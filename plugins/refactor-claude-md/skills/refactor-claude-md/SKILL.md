---
name: refactor-claude-md
description: Use when a CLAUDE.md has grown long, contradicts itself, or repeats things the agent already knows — and when the user says "refactor CLAUDE.md", "clean up my CLAUDE.md", "split up my CLAUDE.md", "my CLAUDE.md is too long", or "audit CLAUDE.md".
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion
---

> Based on the approach in Matt Pocock's
> [A Complete Guide to AGENTS.md](https://www.aihero.dev/a-complete-guide-to-agents-md),
> rewritten and corrected.

# Refactor CLAUDE.md

Split one bloated `CLAUDE.md` into a minimal root file plus linked topic docs, so an agent
loads only what the current task needs.

**Nothing is lost silently.** Every line of the original must end up in exactly one of three
places: the root file, a topic doc, or the flagged-for-deletion list you show the user. If a
line lands nowhere, you dropped it — go back.

## 0. Read the memory first

Read `memory.md` next to this skill before doing anything else. It records how this user ruled
on past contradictions and what they insist stays in the root file. Apply those rulings instead
of re-asking. Ask only about what the memory does not already answer.

## 1. Find contradictions

Read the whole file. List instruction pairs that genuinely conflict — same subject, incompatible
demands ("always use pnpm" vs. an `npm install` example; "never comment" vs. "document every
export"). Overlap is not contradiction; do not manufacture conflicts to have something to ask.

Collect them all, then ask in **one** `AskUserQuestion` batch (up to 4 per call), each option
quoting the competing lines verbatim. Never resolve a real contradiction yourself.

## 2. Keep only the essentials in root

The root `CLAUDE.md` holds what is true for *every single task*:

- One-sentence project description
- Package manager, if not npm
- Build/typecheck/test commands, but only where they are non-standard
- Constraints that would break any task if unknown (monorepo layout, generated files, a hard
  "never touch X")

Everything else moves out. If you can name a task where the instruction is irrelevant, it moves.

## 3. Group the rest

Cluster by *when the agent would need it*, not by topic taxonomy. Typical files: TypeScript
conventions, testing, API design, git workflow, deployment, database. One file per group, named
for its trigger. Fold a group of fewer than ~3 instructions into a neighbour rather than making
a file nobody opens.

## 4. Write the structure

```
CLAUDE.md              minimal, links out
docs/
  typescript.md
  testing.md
  api-design.md
  git-workflow.md
```

Root links carry a *when* clause, since the link text is all the agent sees before deciding to
open it:

```markdown
- [TypeScript conventions](docs/typescript.md) — read before writing or changing `.ts` files
- [Testing](docs/testing.md) — read before adding or fixing tests
```

Write the docs first, then rewrite root, then confirm every original line is accounted for.

## 5. Flag for deletion — propose, do not delete

Collect the lines worth cutting into a list at the end of your reply, one line each with the
reason:

| Reason | Example |
|---|---|
| Already known | "use async/await instead of callbacks", "prefer const" |
| Too vague | "handle errors properly", "follow best practices" |
| Obvious | "write clean code", "keep functions small" |

These are the user's instructions. Show the list, get one approval, then cut. Do not delete
uninstructed.

## 6. Append to memory

After the user rules on anything — a contradiction, a "that stays in root", a rejected deletion
— append it to `memory.md` in the format that file defines. That is what stops the next run from
re-litigating the same lines.

## Common mistakes

- **Asking contradictions one at a time.** Batch them; the user answers once.
- **Root that still explains conventions.** If root says *how* to write a test, it belongs in the
  testing doc.
- **Bare links.** A link without a "when" clause never gets opened.
- **Deleting on your own judgment.** Step 5 flags; the user cuts.
- **Rewriting instructions while moving them.** Move verbatim. Refactor is relocation, not
  editing — reword only when the user asks.
