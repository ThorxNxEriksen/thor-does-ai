# Phase 2 — working through proposals

Phase 1 wrote the proposals. This is how they get decided and applied: everything triaged
first, then one proposal at a time, each behind its own gate.

Run the scripts from this skill's directory. Proposals and the ledger live in the output
directory — `CLAUDE_REVIEW_DIR` if set, otherwise
`~/.claude/reviews-from-review-sessions-skill/` — written below as `<output>`.

## 0. Rendering is not approval

Reading a proposal aloud, summarising it, or agreeing that it sounds sensible is not approval
to act on it. Nothing is edited until that proposal's own gate in step 5 has been answered.

The failure this phase exists to prevent: the user says "let's work through the proposals" and
the session starts *building the thing the first proposal describes*. They asked to decide, not
to be handed a result.

## 1. Locate the open set

```sh
node status.mjs
```

`OPEN` is the working set. Skip `ACTIONED` and `DECLINED` — those were answered, and a decision
is not re-asked. Exception: a `DECLINED` row whose cluster has since recurred is worth raising,
but as a *new* proposal from a new review, never by silently reopening the old one.

For each open row, the full text lives at `<output>/<source.file>` → `## <source.section>`. A row
written before `source` became mandatory carries no pointer, and a row whose pointer no longer
resolves is the same case: **ask which file holds it rather than guessing.** Guessing produces a
proposal rendered from the wrong text, which is worse than asking.

**`R-`-prefixed rows are filed reports, not proposals, and have no `source` by design.** Their
full text is the `text` field on the row itself — read it there and do not go looking for a
proposals file. A report has no proposal attached yet, so there is nothing to render for approval
and nothing to apply: what it needs is a phase 1 review to turn it into a finding. Triage it with
the rest, and the two useful answers are "next review picks this up" (leave it open) or
`declined` with a note, typically because it was a one-off or already fixed itself. Do not invent
a fix for it here; that is phase 1's job, with the corpus in front of it.

Read only the sections you are about to render. The proposals files run 12–24 KB and this
phase also has to hold the files it will edit.

## 2. Triage everything, before deciding anything

One pass over the whole open set, batched up to 4 per `AskUserQuestion` call. Give the user
what they need to judge cost, not just merit — the usual reason to defer is time, not doubt:

| show | from |
|---|---|
| id and target | `id`, `target.name` |
| what kind of change | `kind` — CLAUDE.md line / edit to an existing skill / new skill |
| how strong the evidence is | `recurrence.sessions` |
| roughly how big the job is | implied by `kind`: a CLAUDE.md line is minutes, a new skill is not |

Three options, per proposal:

- **`Work on this now`** — it survives to a gate. Write nothing yet; the gate writes the row.
- **`Work on this later`** — **write nothing at all.** A finding with no decision row *is* OPEN —
  that is literally how `status.mjs` folds it — so "later" is exactly a row not written, and it
  returns at the next triage. Do not invent a `deferred` state.
- **`No, decline it`** — append the `declined` row immediately, before moving on, so an early no
  is never re-asked and never re-derived.

## 3. Order the survivors

1. Proposed changes to `~/.claude/CLAUDE.md`
2. Proposed updates to existing skills
3. Proposed new skills

Cheapest and most reversible first; the new skills last, because they are the ones likely to
run out of context, and everything ahead of them will already be recorded by then.

## 4. Render the proposal, in full and verbatim

Before the gate, print that proposal's sections **exactly as written in the proposals file** —
do not summarise, re-order, shorten, or "improve" them:

**Recurrence** → **Problem** → **Principle** → **Proposed edit** → **Evidence** →
**Cross-checked** → **Trade-offs** → **Decision**

Verbatim matters because the point of this step is that the user sees what the review actually
concluded, not this session's paraphrase of it. Older proposals predate parts of the contract and
will be missing sections — **Trade-offs** is the usual one. Say which section is missing and that
it was never written, then render what is there. **Do not write the missing section.** A
trade-off invented now is this session's opinion wearing the review's evidence, and back-filling
it has been explicitly declined.

## 5. The gate — one proposal, one question

One `AskUserQuestion`, single-select, with the proposal's exact **Proposed edit** text in the
option `preview` so the change is visible at the moment of choosing:

- **`Yes, implement this change exactly as proposed`**
- **`Implement this change with a small addition`** — then ask what the addition is, restate the
  resulting text **in full**, and act on the restated version. Never act on "as proposed, plus
  roughly what they said".
- **`No, do not implement this`** → `declined`.

One question covers one proposal. Never bundle two proposals into one question, and never treat
approval of one as approval of the next.

## 6. Apply, then record

Only after an explicit yes:

1. **Back up the target file first.** `~/.claude` is unversioned — CLAUDE.md, skills,
   `settings.json` and hooks are machine-wide with no rollback.
2. **Change only what that proposal specifies.** Anything else you notice along the way is a new
   proposal for the next review, not a free edit while you are in the file.
3. **Append one row** to `<output>/findings-and-decisions.jsonl`:

```json
{"row":"decision","obs":"2026-08-14-01","at":"<iso>","decision":"actioned","by":"user","note":"…"}
```

`row` must be `decision`. Without it the row is not a decision to `status.mjs` and the finding
stays OPEN forever.

`decision` is `actioned` or `declined`. One explicit answer, one row. Never write a row for a
proposal the user did not answer individually, and never infer `actioned` from having done the
edit — the row attests to the approval, not to the work.

Write the row as soon as the answer is given, not in a batch at the end. That is what makes an
interrupted session resumable.

## 7. Stopping part-way is the expected case

Six proposals with real edits will not fit one context window. When it gets thin, stop cleanly:
say which ids are done, which are still open, and that `node status.mjs` resumes it in a fresh
session. Everything already answered is already on disk.

Never batch the remaining gates to get finished. A rushed yes to four proposals at once is the
exact outcome this whole phase is built to prevent.

## 8. Report

One line: ids actioned, ids declined, ids left open, and what remains.
