---
name: handoff
description: Use when a session must stop mid-work and another Claude session picks it up — hitting a usage or capacity limit, switching between Claude accounts, ending a session with work in flight, or starting a session that should continue work left behind. Triggers on "handoff", "out of capacity", "switch accounts", "resume where we left off", and equally on the ordinary phrases that come *before* the wall: "note down the progress", "save this conversation", "going to sleep", "closing my computer", "so I can restart Claude", "keep working on this tomorrow", "finish this task and then wait". Also use unprompted when the usage meter is near its limit and work is in flight.
---

# Handoff

Move in-flight work between sessions on the same machine. The files stay put; only the conversation context is lost. The handoff file IS that context — written to be executed, not read.

Location: `.claude/handoff.md` at the root of the current tree (the worktree root when in a worktree). On resume, if that file is absent, check `.claude-handoff.md` in the same root before reporting none — earlier sessions wrote there — then normalise to `.claude/handoff.md`.

## When to write one without being asked

Work is in flight and any of these is true — write it, say in one line that you are writing it and where, do not ask permission:

- the usage meter for the current window is past ~85%, or a rate-limit warning has appeared;
- the user signals they are stopping ("going to sleep", "closing my computer", "back tomorrow") — finish the current task, then write the handoff, then stop;
- the user says they will restart the session, switch accounts, or clear context;
- a subagent-driven plan finished a task and the next one will not fit in the remaining budget.

An unneeded handoff costs one Write call. A missing one costs the session.

## Mode: writing a handoff

You are near a capacity limit. **Do not explore.** No file reads, no searches, no verification runs. Write from what is already in context, plus at most one `git status --short`. One Write call, then stop.

The file has exactly these sections, in this order:

```markdown
# Handoff: <one-line goal> — <YYYY-MM-DD HH:MM>

**Tree:** <absolute path> · branch `<name>`
**Uncommitted:** <files from git status --short, or "clean">
**Tests:** <last command run + its result, or "not run">
**Still running:** <subagents, background shells and dev servers this session started and did not stop — id, what, port; or "none">

## Done
- <verified-complete items only>

## Next
1. <concrete action: file path + what to change>
2. ...

## Decisions
- <choice> — <why>

## Dead ends
- <tried, didn't work> — don't retry
```

Content rules:
- **Next** is the point of the file. Item 1 must be executable without asking the user anything.
- **Done** holds only what you verified. Anything unverified is a Next item.
- Name files by path. "the auth module" is not a path.
- No conversation narrative, no recap of what the user said.
- Before writing, stop or await every background task you started. Whatever you deliberately leave running goes in **Still running** — the next session cannot see it any other way. This comes from context, not exploration.

If you are in a worktree, ExitWorktree with `action: "keep"`. Then tell the user: switch account, start Claude in `<tree path>`, say "resume handoff".

## Mode: resuming a handoff

1. Read `.claude/handoff.md`, falling back to `.claude-handoff.md`. If neither exists, say so and stop.
2. Run `git status --short`. If it disagrees with **Uncommitted**, report the difference before touching anything.
   If **Still running** lists anything, check whether it still is (`lsof -nP -iTCP -sTCP:LISTEN` for ports, `ps` for PIDs) and report it.
3. Report three lines: goal, where it stopped, first Next item.
4. Delete `.claude/handoff.md` — a consumed handoff must not be resumed twice.
5. Do Next item 1.

Read Decisions and Dead ends before proposing anything. Re-litigating a settled decision or retrying a dead end burns the capacity the handoff exists to save.

## Common mistakes

| Mistake | Fix |
|---|---|
| Summarizing the conversation | Use the sections above only. The next session needs state, not history. |
| Exploring to "make the handoff complete" | You are out of capacity. A missing detail costs the next session one grep; running out mid-write costs the whole handoff. |
| Filing in-progress work under Done | Done = verified. Everything else is Next. |
| Leaving the file in place after resuming | Delete it. Stale handoffs get resumed weeks later. |
| Writing it into the main repo while working in a worktree | Root of the *current* tree. The next session starts where you stopped. |
