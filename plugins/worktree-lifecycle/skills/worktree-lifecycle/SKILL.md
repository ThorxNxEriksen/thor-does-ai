---
name: worktree-lifecycle
description: Create, check, and tear down git worktrees for a task - the whole lifecycle, not just entry. Use whenever the user wants a new or fresh worktree, asks whether a worktree is synced or up to date with main/master, wants to switch into an existing worktree, needs .env.local or other gitignored files inside one (.worktreeinclude), hits "fatal: '<branch>' is already used by worktree at '<path>'", wants to merge a worktree back, or asks to close, remove, clean up or finish with one - including "why is it so hard to close this worktree", "what's the difference between a git worktree and a claude worktree", and the start of any task, since work never happens on the target branch.
---

# Worktree lifecycle

`wt.mjs` in this skill's directory answers the two questions every step below depends on - where this worktree stands against its base, and what removing it would lose. It is read-only.

```sh
node <this skill's dir>/wt.mjs status [path] [--base <ref>]
```

It prints the branch, the base (`origin/<default>`, or the local default when there is no remote), ahead/behind, the dirty files and unmerged commits that removal would lose, a `SYNCED` / `NOT synced` verdict, and every worktree of the repo with the branch it holds. `--self-check` runs its tests.

A Claude worktree *is* a git worktree. `EnterWorktree` runs `git worktree add` into `.claude/worktrees/<name>/` on branch `worktree-<name>`, copies the gitignored files `.worktreeinclude` names, and moves the session into it. Use it rather than `git worktree add`: `ExitWorktree` can only remove a worktree that `EnterWorktree` created in the same session, and anything else has to be removed by hand.

## Create

1. Run `status`. If the session is already in a linked worktree (no `(MAIN checkout)` marker), `ExitWorktree` with `action: "keep"` first.
2. If the repo has a remote, `git fetch`. `EnterWorktree` branches from `origin/<default>`, so skipping the fetch branches from a stale base. With no remote it branches from local HEAD, which needs nothing.
3. `EnterWorktree` with a `name` for the task.
4. Run `status` again. `behind 0` confirms the base was current.

**Gitignored files** (`.env.local` and the like) come across only if they are listed in `.worktreeinclude` at the repo root. It uses gitignore syntax, and a file is copied only when it matches a pattern *and* is gitignored. The copy happens when the worktree is created. For a worktree that already exists, copy the file over by hand.

**An existing worktree**: `EnterWorktree` with `path`. Remember that this worktree cannot be removed with `ExitWorktree` later.

## "already used by worktree"

```
fatal: 'main' is already used by worktree at '<path>'
```

Git checks a branch out in at most one worktree. This error almost always means something tried `git checkout <base>` inside a linked worktree, usually to merge or to pull. Don't. The base belongs to the main checkout, so work on it from there. A worktree-isolated session cannot reach the main checkout with `git -C <main-path>`, because the harness refuses any git command redirected outside the worktree. Leave the worktree first (`ExitWorktree`, `action: "keep"`). `status` lists which path holds each branch. If that path is marked `prunable` (its directory is gone), `git worktree prune` frees the branch.

## Teardown

1. Run `status` on the worktree. Show the user its `would be lost on removal` lines exactly as printed. If it says `nothing`, proceed. Otherwise commit, or let the user decide what to do with the rest. Never discard work you did not create.
2. **Stop what runs from it.** Stop any dev server, watcher or background shell this session started in the worktree (`lsof -nP -iTCP -sTCP:LISTEN`, then `kill <pid>`). A process that still holds a file inside the directory makes removal fail. On Windows, `git worktree remove` then fails half-way: it has already deregistered the worktree but leaves the directory on disk.
3. **Nothing to merge** (the user doesn't want the work, or `status` shows `ahead 0`), and `EnterWorktree` created it in this session: use `ExitWorktree` with `action: "remove"`, and you are done.
4. **Merge back**, only if the user wants it:
   1. `ExitWorktree` with `action: "keep"`. This step can't be skipped. Inside the worktree the harness refuses `git -C <main-path>`, and checking out the base inside the worktree fails with "already used by worktree".
   2. From the main checkout, which is now the session's directory: `git merge <branch>`.
   3. `git worktree remove <path>`, then `git branch -d <branch>`. `-d` refuses an unmerged branch, and that refusal is the safety net. Use `-D` or `--force` only on the user's say-so.
5. **A worktree this session didn't create**: the same as step 4, minus the merge if there isn't one. `ExitWorktree` can't remove it.
6. If removal failed part-way, run `git worktree prune`, then delete the leftover directory once nothing holds it.
7. Run `status` from the main checkout. The worktree should no longer be listed.
