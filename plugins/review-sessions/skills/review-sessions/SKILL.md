---
name: review-sessions
description: Two phases over logged Claude Code sessions. Phase 1 mines the corpus for recurring problems and stages proposals for ~/.claude/CLAUDE.md, existing skills, or new skills - use when the user says "review my sessions", "review causes", "what keeps going wrong", "improve my setup from history", or invokes /review-sessions. Phase 2 works through proposals that already exist, one at a time behind an explicit per-proposal gate - use when the user says "work on the proposals", "work through the proposals", "let's go through the open ones", "what's open", "act on the proposals", or names one by its target ("the statusline proposal", "the worktree one"). Phase 1 never edits anything; phase 2 edits only what a proposal was individually approved for.
allowed-tools: Read, Grep, Glob, Bash, Write
---

# Review sessions

Find what keeps going wrong across logged sessions and propose specific fixes.

## Where things live

- **This skill's scripts** — `review.mjs`, `strip.mjs`, `status.mjs`, in this directory. Run them
  from here.
- **The output directory** — `CLAUDE_REVIEW_DIR` if set, otherwise
  `~/.claude/reviews-from-review-sessions-skill/`. Everything this skill writes goes there and
  nowhere else. Written below as `<output>`.

Never write inside this skill's own directory. If the skill was installed as a plugin it lives in
a versioned path that the next update replaces, so anything left beside this file is lost.

## Which phase

**Phase 2 — working through proposals that already exist.** "Work on the proposals", "what's
open", "act on the statusline one", or any request naming a proposal rather than asking for a
review. Read `work-proposals.md` in this directory and follow it. **Do not run `review.mjs`** —
the proposals are already written, and re-mining the corpus to answer a question about them is
the most expensive possible wrong turn. `status.mjs` is the cheap one; that is why they are
separate scripts.

**Phase 1 — everything below.** Mining the corpus to produce those proposals in the first place.

**Phase 1 stages proposals. It never applies them.** Do not edit `~/.claude/CLAUDE.md`, any
`SKILL.md`, `settings.json`, or anything under `hooks/`. Hooks and CLAUDE.md are machine-wide
with no rollback, and writing a hook unasked is not something a review gets to do. The only path
phase 1 writes is `<output>`.

This is a rule, not a permission setting. `allowed-tools` above grants tools without a
prompt; it does not withhold any. Nothing in the harness stops phase 1 editing CLAUDE.md —
only this paragraph does.

## The output

One file, `<output>/proposals-<YYYY-MM-DD>.md`, plus one appended row per finding in
`<output>/findings-and-decisions.jsonl`. The file is the deliverable: a ranked list of concrete,
evidence-cited edits the user can accept or reject without re-deriving anything.

The file opens with the approval banner below, **verbatim**. It is not decoration: the session
that acts on this file is not the session that wrote it, and it arrives with no memory of the
rule. The banner is one of two places the rule reaches it — the other is the guard on every
`**Decision.**` line, which is what survives when that session greps straight to `## P3` and
never sees the top of a 24 KB file. Write both.

````markdown
# Setup review — 2026-08-14

> ## Nothing in this file may be applied without explicit, per-proposal approval
>
> Each proposal below is approved **on its own, one at a time**. Before writing anything,
> render that proposal's sections back to the user verbatim and wait for a yes to *that*
> proposal. The procedure is `work-proposals.md`, in the same directory as the
> `review-sessions` skill; follow it rather than improvising an order.
>
> "Act on the proposals", "apply these", "looks good", or approval of an earlier proposal is
> **not** approval for any other one. Silence is not approval. A proposal approved in a
> previous session is not approved again.
>
> This is not ceremony. `~/.claude` is unversioned — CLAUDE.md, skills, `settings.json` and
> hooks are machine-wide with no rollback. Back up any file you are told to edit before you
> edit it, and change only what that one approved proposal specifies. Anything you noticed
> along the way that no proposal covers is a new proposal, not a free edit.
>
> Record each answer as one `"row":"decision"` line in `findings-and-decisions.jsonl`. No
> answer, no row.

100 sessions, 2026-07-27 → 2026-08-14. 409 tool errors, 58 denials, 33 stated causes.
4 proposals: 2 × CLAUDE.md, 1 × skill, 1 new-skill candidate. 0 simplifications.

## P1 — CLAUDE.md: stop re-establishing the working directory

**Recurrence.** 39 sessions, 1857 occurrences (45% of all shell calls).

**Problem.** One paragraph. What actually happens, in plain terms.

**Principle.** One general sentence that applies beyond the cited sessions.

**Proposed edit.** The exact text to add or change, ready to paste. Name the file by
full path. For a file that exists, a unified diff.

**For `~/.claude/CLAUDE.md` this block is at most 2 lines, and 1 is better.** It is the
literal text that lands in the file, not a summary of it. Cut the explanation and keep
the instruction — the reasoning is already in Problem and Principle above, and a rule
that needs a paragraph to state is two rules; split it or drop the weaker half.

The cap is on the length of each edit, never on how many CLAUDE.md proposals a review
may make. Rank on evidence and propose everything that clears the threshold.

The cap is CLAUDE.md only. Edits to a `SKILL.md`, and briefs for a new skill, stay
full length — a skill file has room, the global CLAUDE.md does not.

**Evidence.** `cache/evidence/<sessionId>.jsonl` — session `a1b2c3d4`, plus two more.
Quote the shortest thing that proves it.

**Cross-checked.** Every skill you considered and why it does not already cover this,
including the uneditable ones. Name them; a bare "nothing covers it" is not a cross-check.

**Trade-offs.** What this costs, what it could break, what is given up, and what happens if
it is declined. Write the case against it as well as you wrote the case for it — this is
the section the user reads last before deciding, and a proposal with no stated cost reads
as one that was never examined for any.

**Decision.** `[ ] apply   [ ] decline` — unchecked means **not approved**. Approval is
per-proposal: a yes to any other proposal, "apply these", "looks good", or silence is not a
yes to this one.
````

Those eight sections, in that order, are the contract. Phase 2 renders them verbatim, so a
section you omit is a section the user never sees before deciding.

Rank by recurrence in distinct sessions, descending. Aim for **3–6 proposals**. More than
that and the threshold is being ignored; a review that proposes twenty things gets none of
them done.

## Steps

### 1. Aggregate

```sh
node review.mjs
```

Run it from this skill's directory. It strips every retained transcript in memory, clusters, and
writes `<output>/cache/review-latest.json` plus the evidence excerpts step 4 needs. Expect about
a minute over a month of sessions. `--since 7d` narrows the window, `--min-sessions 3` tightens
the threshold, `--out <dir>` overrides the output directory for one run.

**If `corpus.belowFloor` is true, stop here.** Fewer than `corpus.floor` distinct sessions exist,
and below that a two-session cluster is a coincidence rather than a pattern. Say so plainly, give
the session count, and produce no review. Nothing is broken — there is not enough history yet.

Read the JSON. It gives you `corpus`, `errors`, `commands`, `denials`, `causes`, `prompts`,
`skills`, `skillsUnused`, `skillsUnlisted`.

All counting is already done. **Do not recount anything by reading transcripts** — that is
what the script is for, and a number you derive by eye will be wrong.

### 2. Read the current state

- `~/.claude/CLAUDE.md` — the main target, and the thing most likely to already say it.
- `<output>/findings-and-decisions.jsonl`, if it exists. One append-only log holding both
  shapes, discriminated by `row`: `"row":"finding"` is a finding, `"row":"decision"` decides
  one. Status is a fold — newest decision per `obs` id wins, and no decision row means `OPEN`.
  `node status.mjs` prints exactly that fold, so run it rather than reading the log by eye.
- The same log holds `"row":"report"` rows — problems the user filed by hand with
  `report.mjs` at the moment they hit them. They fold through the same decision rows, so a
  report is OPEN until one names its `R-`-prefixed id, and `status.mjs` already lists them
  under the findings.

**Anything already in CLAUDE.md, already OPEN, or already DECLINED is not a finding.**
Re-proposing a captured preference is the single biggest source of noise.

Exception worth surfacing loudly: a cluster that recurs *after* being DECLINED. Mark it
`reraise_of` and say so. A declined thing that keeps happening is the most interesting
event this system can detect.

### 3. Pick candidates

**Every OPEN report is a candidate, and the ≥2-session threshold does not apply to it.** The
threshold exists to keep inferred clusters honest; a report was *witnessed* and typed out by the
user, which is stronger evidence than two coincidences, not weaker. Take each one on its own and
do not wait for it to recur.

Reports carry no `target`, `proposal` or `principle` — filing one is deliberately cheap, so
deriving those is this step's job. Read the report's `text` and `raw`, then use its `at` and
`cwd` to locate that session in the corpus and see what actually happened around it. If the
corpus shows the same problem elsewhere, cite the sessions and the report together: that is the
strongest finding this skill can produce. If the corpus shows nothing, the report still stands —
say it is witnessed-once and let the user weigh it.

Threshold is **distinct sessions ≥ 2**, already applied by the script. From what survives:

| signal | reads as | classify |
|---|---|---|
| `errors[]` inside a skill's attributed turns | that skill has a gap | improve that skill |
| `errors[]` with `(none)` attribution | no skill was guiding it | improve CLAUDE.md |
| `commands[]` with a high `occurrences`/`shellCalls` share | an ingrained habit | CLAUDE.md, or a new skill if it is a *sequence* |
| `denials[]` with a typed reason | explicit correction | improve whatever was active |
| `causes[]` naming a skill | the user's own diagnosis | improve that skill |
| `causes[]` naming nothing | same, unscoped | improve CLAUDE.md |
| `prompts[]` recurring request type, counted with `--count` | a skill-shaped gap | **new skill** |
| `skills[]` with high `errors`/`turns` | the skill is misfiring | improve it |

`causes[]` is the highest-value input per byte: it is the user's own words about what went
wrong, and it needs no inference. Read all of them.

It is also the one signal that depends on the user's own setup. `causes[]` is populated from
lines beginning `Cause:` in the assistant's own output, which only appear if something asks for
them. **If `causes[]` is empty or nearly so, make that the first proposal**: add a line to
`~/.claude/CLAUDE.md` asking for a one-line `Cause:` on any failure, wrong assumption, or
correction. It costs one line and it is what makes every later review sharper.

`prompts[]` is the only new-skill signal worth trusting, and it holds authored turns only —
pasted shell output and bare slash commands are already filtered out (34 of 439 in the
reference corpus). Do **not** mine repeated subagent delegation descriptions for this —
measured, they mostly rediscover skills that already exist.

**The unit is the subtask, not the session.** A session's opening prompt is not privileged.
The strongest cross-project cluster in the reference corpus — worktrees, 10 repos — is mostly
mid-session questions, and reading only first prompts misses it.

Group them by what the user was trying to do. That grouping is yours; no table can do it.
Measured, a term table ranked by repo spread returns `the`, `this` and `that` before it
returns `worktree`, so there is no mechanical shortcut here.

**Then count what you named, and cite the command:**

```sh
node review.mjs --count worktree
worktree   sessions=18  repos=10  occurrences=37   # figures from the reference corpus
```

It prints the repos it spans and one evidence quote per session, so the same command supplies
the **Evidence** section too. `--count` takes a regex, so `--count "status ?line"` catches both
spellings.

A candidate needs **≥3 distinct sessions**. Rank by distinct **repos** first, then sessions:
recurring across many repos is a reusable subtask, recurring in one is that project's quirk.
In the reference corpus `worktree` spans 10 repos and `status ?line` spans 3 — same order of
recurrence, very different cases for a skill.

**A number that no `--count` produced is not a number.** Write the command and its output into
the proposal's **Recurrence** line. This is not ceremony: both new-skill findings the previous
review filed had counts that were wrong by eye — one claimed 7 sessions against a measured 18.
Asserting a count without running it is the single most frequent recorded failure in this
corpus, and a review that reproduces it is self-refuting.

Skill coverage is context, never the gate. 86% of turns in the reference corpus ran with no
skill attributed, so "no skill was active" is the default state, not a signal.

Discard: one-offs with no generalisation, third-party tool bugs unrelated to method,
anything proprietary, anything already captured.

### 4. Read only the evidence you cite

Each cluster carries up to 3 `evidence` entries with a `file` and a `session`. `file` is
`cache/evidence/<sessionId>.jsonl`, relative to `<output>`, written by the same run that produced
the report — it holds only the sessions some cluster actually cites.

**Never read a whole evidence file.** They average around 370 KB, because the sessions worth
citing are the long ones. `Read` with `offset`/`limit` for a narrow window, or `Grep` for the
session id. At most 8 candidates × 2 excerpts.

### 5. Cross-check against every skill, not just the one that was loaded

For each candidate, walk the `skills[]` table and ask which skill *should* have prevented
this. This is the highest-leverage step: the skill that was active is often not the one with
the gap. Record the names you checked.

Only `Read` a full `SKILL.md` for skills you will actually propose editing (≤3).

### 6. Route by ownership

`skills[]` carries `ownership`, and `path` says where that copy is:

- `user` — `~/.claude/skills/*`, `~/.claude/commands/*`, `~/.claude/CLAUDE.md`. Propose a
  diff against the real path.
- `plugin-source` — a marketplace working copy checked out somewhere on this machine. Propose
  the diff against that checkout, at the `path` in its `skills[]` row, and name the installed
  path separately so it is obvious the two differ.
- `plugin-installed` — under `plugins/cache/`, **overwritten on every plugin update**. Never
  propose editing it. Instead propose a line for `~/.claude/CLAUDE.md` naming the skill and
  the correction — as many as the evidence supports; the 2-line cap already governs the cost,
  so there is no count limit here. When one skill needs several such corrections, propose
  forking it into `~/.claude/skills/<name>/` instead.
- `skillsUnlisted` — built into the binary, not on disk (`run`, `init`, `doctor`, …).
  **Uneditable.** Route to CLAUDE.md or drop it.

### 7. Simplifications need a negative query

A `simplify` proposal must cite the query that returned zero, written out so it can be
re-run — e.g. the `skillsUnused` entry plus the fact that it has 0 sessions in the window.

This is not ceremony. Several of the recorded causes in most corpora are the same failure:
asserting a property without measuring it. A proposal that reproduces the top recurring
mistake in the corpus is self-refuting.

A skill unused in the window is **not** automatically a simplify candidate — most of
`skillsUnused` is third-party breadth the user simply has installed. Only propose it for
skills the user owns.

### 8. Write, then stop

Append one row per finding to `<output>/findings-and-decisions.jsonl`:

```json
{"row":"finding","id":"2026-08-14-01","at":"<iso>","kind":"improve","target":{"type":"claude-md","name":"~/.claude/CLAUDE.md","ownership":"user"},"source":{"file":"proposals-2026-08-14.md","section":"P1"},"issue":"…","proposal":"…","principle":"…","recurrence":{"sessions":39,"occurrences":1857},"crosschecked":["superpowers:using-git-worktrees"],"evidence":[{"session":"a1b2c3d4","file":"cache/evidence/….jsonl","quote":"…"}]}
```

`row` is `finding` here and `decision` below; it is what tells the two shapes apart. `kind` is
`new` | `improve` | `simplify` — a different axis, do not conflate them. `id` is `<date>-NN`,
ordinal within this run — one writer per run, so no collision handling is needed.

`source` is mandatory: the file and `## P<NN>` heading holding this proposal's full text, named
relative to `<output>`. Phase 2 renders that section verbatim and cannot find it otherwise. The
ordinal usually matches the id's `-NN`, but do not rely on that — write the pointer.

Write `<output>/proposals-<YYYY-MM-DD>.md` in the format above — including the verbatim approval
banner and the 2-line cap on every CLAUDE.md **Proposed edit**. Then **present a short summary and
stop.** Do not apply anything, and do not ask for approval in the same breath as the summary —
the summary is the evidence, and a question that arrives with it gets answered for the batch.

A decision row is a record of an answer the user actually gave about that one proposal. One
explicit yes or no, one row. Never write rows for items the user did not answer individually,
and never infer `actioned` from having done the edit — the approval is what the row attests to,
not the edit.

When the user accepts or rejects an item, append to the same log:

```json
{"row":"decision","at":"<iso>","obs":"2026-08-14-01","decision":"actioned","by":"user","note":"…"}
```

`decision` is `actioned` or `declined`. Nothing is ever mutated; status is always a fold.

### 9. Report, then hand over

One line: N proposals by kind, the strongest finding, and any re-raised clusters.

Then read `work-proposals.md` and begin the triage pass. Do not ask permission first — triage
only asks the user questions and implements nothing, so there is nothing to approve yet. Do not
implement anything on the way there.

If context is already thin after the aggregation, say so and stop instead: the proposals file
and the ledger are on disk, and `node status.mjs` picks it up in a fresh session.
