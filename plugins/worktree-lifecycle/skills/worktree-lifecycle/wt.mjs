#!/usr/bin/env node
// Where does this worktree stand against its base, and what would removing it lose?
//
//   node wt.mjs status [path] [--base <ref>]   # path defaults to the current directory
//   node wt.mjs --self-check
//
// Read-only. It never creates, merges or removes anything; the skill decides that from this
// output. Zero dependencies, and git is called without a shell so it runs the same on Windows.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const tryGit = (cwd, ...args) => {
  try { return git(cwd, ...args); } catch { return null; }
};

// The branch new work should be compared with: origin's default if there is a remote, else the
// local default. Fetching is the caller's job -- a stale origin/<x> is reported, not fixed.
export function baseRef(cwd) {
  const head = tryGit(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (head) return head;
  for (const ref of ["origin/main", "origin/master", "main", "master"])
    if (tryGit(cwd, "rev-parse", "--verify", "--quiet", ref)) return ref;
  return null;
}

// Every worktree of this repo, main one first, as {path, branch}. Answers "which path holds
// branch X" for the `already used by worktree` error.
export function worktrees(cwd) {
  const out = [];
  for (const block of git(cwd, "worktree", "list", "--porcelain").split(/\n\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? (/^detached$/m.test(block) ? "(detached)" : "(bare)");
    out.push({ path, branch, prunable: /^prunable/m.test(block) });
  }
  return out;
}

export function status(path, base) {
  const top = git(path, "rev-parse", "--show-toplevel");
  const all = worktrees(top);
  const branch = tryGit(top, "symbolic-ref", "--short", "HEAD") ?? "(detached)";
  base ??= baseRef(top);
  const dirty = git(top, "status", "--porcelain").split("\n").filter(Boolean);
  let ahead = null, behind = null, unmerged = [];
  if (base) {
    [behind, ahead] = git(top, "rev-list", "--left-right", "--count", `${base}...HEAD`).split(/\s+/).map(Number);
    unmerged = ahead ? git(top, "log", "--oneline", `${base}..HEAD`).split("\n") : [];
  }
  return { top, branch, base, ahead, behind, dirty, unmerged, isMain: samePath(all[0]?.path, top), worktrees: all };
}

const samePath = (a, b) => !!a && !!b && realpathSync(a) === realpathSync(b);

function print(s) {
  const L = [];
  L.push(`worktree  ${s.top}${s.isMain ? "   (MAIN checkout)" : ""}`);
  L.push(`branch    ${s.branch}`);
  if (!s.base) L.push("base      (none found -- pass --base <ref>)");
  else L.push(`base      ${s.base}   ahead ${s.ahead}, behind ${s.behind}`);
  L.push(`dirty     ${s.dirty.length} file(s)`);
  const synced = s.base && s.ahead === 0 && s.behind === 0 && s.dirty.length === 0;
  L.push(`verdict   ${synced ? "SYNCED with base" : s.base ? "NOT synced" : "unknown"}`);
  if (s.dirty.length || s.unmerged.length) {
    L.push("would be lost on removal:");
    for (const d of s.dirty) L.push(`  uncommitted  ${d}`);
    for (const c of s.unmerged) L.push(`  not in base  ${c}`);
  } else if (s.base) L.push("would be lost on removal: nothing");
  L.push("all worktrees:");
  for (const w of s.worktrees) L.push(`  ${w.branch.padEnd(32)} ${w.path}${w.prunable ? "   (prunable: dir gone)" : ""}`);
  console.log(L.join("\n"));
}

function selfCheck() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-check-")));
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const g = (...a) => git(repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a);
    writeFileSync(join(repo, "a.txt"), "a\n");
    g("add", "a.txt"); g("commit", "-qm", "one");
    assert(baseRef(repo) === "main", "no remote: base falls back to local main");

    const wt = join(root, "wt");
    g("worktree", "add", "-q", "-b", "feat", wt);
    let s = status(wt);
    assert(s.branch === "feat" && s.ahead === 0 && s.behind === 0 && s.dirty.length === 0, "fresh worktree is synced");
    assert(!s.isMain && status(repo).isMain, "main checkout is told apart from a linked worktree");
    assert(s.worktrees.find((w) => w.branch === "main")?.path === repo, "which path holds main");

    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "add", "b.txt");
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "two");
    writeFileSync(join(wt, "c.txt"), "c\n");
    s = status(wt);
    assert(s.ahead === 1 && s.unmerged.length === 1 && s.unmerged[0].endsWith("two"), "unmerged commit reported");
    assert(s.dirty.length === 1 && s.dirty[0].includes("c.txt"), "untracked file reported");

    g("commit", "-q", "--allow-empty", "-m", "three");
    assert(status(wt).behind === 1, "behind base reported");
    assert(status(wt, "feat").ahead === 0, "--base override is honoured");

    // The teardown facts SKILL.md relies on.
    assert(tryGit(repo, "branch", "-d", "feat") === null, "branch -d refuses a branch still checked out / unmerged");
    rmSync(wt, { recursive: true, force: true });
    assert(worktrees(repo).find((w) => w.branch === "feat")?.prunable, "a deleted worktree dir shows as prunable");
    g("worktree", "prune");
    assert(!worktrees(repo).some((w) => w.branch === "feat"), "prune frees the branch");
    assert(tryGit(repo, "branch", "-d", "feat") === null, "branch -d refuses an unmerged branch");
    console.log("wt.mjs self-check: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-check") selfCheck();
  else if (args[0] === "status") {
    const i = args.indexOf("--base");
    const base = i >= 0 ? args[i + 1] : undefined;
    const path = args.slice(1).find((a, j, arr) => a !== "--base" && arr[j - 1] !== "--base");
    print(status(resolve(path ?? "."), base));
  } else {
    console.error("usage: node wt.mjs status [path] [--base <ref>] | --self-check");
    process.exit(2);
  }
}
