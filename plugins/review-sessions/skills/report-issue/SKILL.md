---
name: report-issue
description: File a one-line report about something wrong with the Claude Code setup, at the moment it happens, so it is registered for later instead of remembered. Use when the user says "report this", "log this issue", "file a report", "register this", "note this for later", "add this to the backlog", or invokes /report-issue - and equally when they simply state that a part of the setup is broken ("my notion MCP keeps dropping auth", "that hook fired twice", "this skill never triggers") without asking for anything to be fixed. Capture only: it diagnoses nothing and fixes nothing.
allowed-tools: Bash, Write
---

# Report a setup issue

One append to `findings-and-decisions.jsonl` in `CLAUDE_REVIEW_DIR` (or
`~/.claude/reviews-from-review-sessions-skill/` if unset), committed, id echoed back. Then stop
and hand the conversation back to whatever the user was doing.

## The rule

**Do not diagnose. Do not fix. Do not investigate.** The user filed this *because* they do not
have time for it now. Turning a five-second report into a debugging session is the one way this
skill fails, and it fails silently: they stop filing reports.

Specifically, do not run `review.mjs`, do not open `review-sessions`, do not read the corpus,
and do not propose a change to `~/.claude/CLAUDE.md`. A report is an inbox row. `review-sessions`
phase 1 picks it up later, with the corpus in front of it, and writes the proposal then.

If the user asks you to fix it *as well*, that is a separate request — file the report first so
it survives, then treat the fix as its own task.

## How

1. Take the user's own words for `text`. Do not rewrite, summarise, or make them precise. A
   vague report is worth having; a report they had to compose is not.
2. Both the prose and any pasted error output must survive verbatim, so pass them as file
   paths, never as shell arguments. Write the prose to a scratch file, and if there is real
   error output worth keeping, write that to a second one.
3. Run it:

```
node <this skill's base directory>/../review-sessions/report.mjs --text-file <prose> [--raw <error>] [--cwd <their cwd>]
```
   The base directory is printed when this skill loads; `report.mjs` ships beside it in the same plugin.

   `--cwd` defaults to the shell's own directory, which is usually right. Add `--session <uuid>`
   only if you actually know it; otherwise leave it off — the review locates the session from
   `at` plus `cwd`. Never invent a uuid.

4. Report back in one line: the id, and that it is open until reviewed. Nothing else.

The script redacts on write, appends, and commits just that one file with an explicit pathspec —
so it cannot sweep up uncommitted work someone else left in that tree. If the commit fails the
row is still on disk; say so and move on rather than repairing git.

## What happens to it

Open until a `"row":"decision"` in the same ledger names the id. `node review-sessions/status.mjs`
lists it alongside the mined findings. Ids are `R-YYYY-MM-DD-NN`; the `R-` prefix is what keeps
them from colliding with finding ids in that shared namespace.
