# review-sessions

Mines your own Claude Code transcripts for the problems that keep recurring, and turns them into
concrete proposed edits to `~/.claude/CLAUDE.md` and your skills — each one cited to the sessions
that justify it, and applied only after you approve it individually.

It reads what Claude Code already logs. Nothing new is recorded, and nothing leaves your machine.

## Install

Install the plugin:

```
/plugin marketplace add ThorxNxEriksen/thor-does-ai
/plugin install review-sessions@thor-does-ai
```

Then ask for a review — "review my sessions", "what keeps going wrong" — or run
`/review-sessions:review-sessions`.

Requires **Node 18 or newer** (`node --version`). No dependencies, no build step, no `npm install`:
every script here uses Node built-ins only.

## The two phases

| | you say | it does |
|---|---|---|
| **1. Review** | "review my sessions" | clusters your transcripts, writes a ranked proposals file, stops |
| **2. Work through** | "work on the proposals" | one proposal at a time, each behind its own yes/no |

Phase 1 never edits anything. Phase 2 edits only what you approved, one proposal at a time, and
records every answer.

## Where it writes

Everything goes to `~/.claude/reviews-from-review-sessions-skill/`:

```
proposals-2026-08-19.md          the deliverable — read this
findings-and-decisions.jsonl     append-only: what was found, what you decided
cache/                           disposable, rebuilt on the next run
```

Set `CLAUDE_REVIEW_DIR` to put that elsewhere — a git repo, if you want your review history
versioned. Nothing is ever written inside the skill folder, so a plugin update cannot destroy your
history.

You can also run the scripts directly, from this directory:

```sh
node review.mjs          # phase 1: cluster and write the report
node review.mjs --count worktree   # how many sessions and repos a candidate spans
node status.mjs          # phase 2: what is open, actioned, declined
```

`review.mjs` takes about a minute over a month of transcripts. `--since 7d` narrows the window,
`--min-sessions 3` raises the bar, `--out <dir>` redirects one run.

## Filing a report

Not every problem recurs across sessions, and not every problem leaves a trace in a transcript at
all — an MCP that drops auth, a hook that fires twice. For those, file it by hand the moment you
hit it:

```sh
node report.mjs "notion MCP dropped auth mid-session"
node report.mjs --text-file prose.txt --raw error.txt
```

This writes one `"row":"report"` line to the same `findings-and-decisions.jsonl` phase 1 reads —
report and finding rows are folded through the same `"row":"decision"` closing mechanism, so
`node status.mjs` lists both, and every open report is a candidate the next review picks up. The
row is committed only when `CLAUDE_REVIEW_DIR` happens to be inside a git repository; outside one
it is still written to disk, just not durably.

## What it needs from you

**Enough history.** Below ten distinct sessions it will tell you so and stop rather than hand you
a review built on coincidences. Come back after a few weeks of use.

**A `Cause:` habit, ideally.** The sharpest signal this skill has is your own diagnosis of what
went wrong, and it only exists if something asks for it. Add a line like this to
`~/.claude/CLAUDE.md`:

> When something goes wrong — a failure, a wrong assumption, or a correction from me — state the
> cause in your response on its own line beginning `Cause:`.

Without it the review still works, using tool errors, denials and shell habits. With it, it gets
substantially better. The skill will propose adding it if it sees you have not.

## Horizon

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30), so a review sees roughly
the last month. That is the deliberate trade for having no hook, no background sweep, and nothing
to install: run it monthly and you lose nothing. If you want a longer horizon, raise
`cleanupPeriodDays` in `~/.claude/settings.json`.

## Privacy

Transcripts contain the contents of every file Claude has read. Nothing here uploads anything, and
API keys, tokens and credentials are redacted out of everything the skill writes. But the output
still holds your shell commands, file paths, repository names and prompts — so if you point
`CLAUDE_REVIEW_DIR` at a git repository, **keep it private.**
