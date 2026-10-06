#!/usr/bin/env node
// Counts recurring problems across your Claude Code sessions, so a review can read a few
// hundred lines instead of 155 MB.
//
// Two passes over the live transcripts:
//   1. cluster    strip every session in memory, group on normalised keys, write the report
//   2. evidence   re-strip only the sessions the clusters cite, so quotes are readable
//
// Nothing is archived and no corpus is kept. The horizon is whatever Claude Code still
// retains (`cleanupPeriodDays`, default 30), which is the deliberate trade for having no
// hook, no scheduled sweep, and nothing to install.
//
// Everything here is mechanical: exact-match grouping on normalised keys. No model, no
// embeddings, no clustering library. The model's job starts where this output ends --
// reading the prose (your prompts, the stated causes) and deciding what a cluster means.
//
// The threshold that matters is DISTINCT SESSIONS, not occurrences: the same mistake twice
// in one session is one mistake, and counting occurrences makes a single bad afternoon look
// like a systemic problem.
//
// Verify with: node review.mjs --self-check
//     Compare against a frozen report: node review.mjs --regress <baseline.json>

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import assert from 'node:assert';

// A transcript records the cwd of the machine that WROTE it, which need not be the machine
// reading it: a Windows corpus reviewed on macOS still has to yield repo names. basename()
// only knows the host separator, so split on both and take the last non-empty segment.
const repoOf = (cwd) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? '?';


import {
  SECRETS,
  discoverRoots,
  groupLiveSessions,
  selfCheck as stripSelfCheck,
  serialize,
  stripSession,
} from './strip.mjs';

const CLAUDE = join(homedir(), '.claude');

// Caps exist so the output stays readable. They are the only tuning knob.
const MAX_EVIDENCE = 3;
const QUOTE = 200;

// Below this many distinct sessions the thresholds below produce noise rather than signal:
// a "2 distinct sessions" cluster means something across 100 sessions and nothing across 6.
// A fresh install has to be told that, or it reads an empty review as a broken tool.
//
// ponytail: a judgment call with no measurement behind it -- 102 sessions is the only corpus
// this has ever been run against. Named so revising it is one edit.
const MIN_SESSIONS_FOR_REVIEW = 10;

// Everything this writes goes here. Never inside the skill folder: a plugin-installed skill
// lives in a versioned directory that the next update replaces, so anything written beside
// SKILL.md is lost on upgrade.
export function outputDir() {
  return process.env.CLAUDE_REVIEW_DIR || join(CLAUDE, 'reviews-from-review-sessions-skill');
}

// ---------------------------------------------------------------------------
// Normalisation -- this is what makes two occurrences "the same problem"
// ---------------------------------------------------------------------------

// Not every "typed" turn was typed. Running `!cmd` puts the command's output back into the
// transcript as a user turn, and a bare slash command is a UI action -- 34 of 439 turns in
// the reference corpus. They are dropped here because grouping request types over them
// finds git output, and because a pasted shell failure is already counted in errors[]:
// keeping it would count one event twice under two signals.
//
// Only structural markers, never wording. Measured against a 60-turn sample labelled by
// three independent raters, this caught 9/9 pastes with no false positives.
//
// An image marker is stripped rather than dropped: `[Image #1] Is there any settings here
// that i should touch?` is a real request that happens to carry a screenshot.
const PASTED_TURN = /^(<bash-(stdout|stderr)>|<command-|Read \d+ file)/;
const BARE_SLASH = /^\/[\p{L}]+\s*$/u;

// Returns the authored text of a typed turn, or null if nothing was authored.
export function promptText(raw) {
  const t = String(raw || '').replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || PASTED_TURN.test(t) || BARE_SLASH.test(t)) return null;
  return t;
}

// Collapse the parts of an error message that vary per occurrence but not per cause:
// absolute paths, line/column numbers, exit codes, hex ids, quoted fragments.
export function errorKey(tool, text) {
  const firstLine = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const norm = firstLine
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/(^|[\s"'(])[\\/][^\s"']{3,}/g, '$1<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${tool}: ${norm}`;
}

// A shell habit is the verb, not the arguments: `cd /a/b && ls` and `cd /c && pwd` are the
// same habit. Two tokens, because `git commit` and `git status` are different habits.
export function commandKey(cmd) {
  const t = String(cmd || '')
    .replace(/^\s*[\r\n]+/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!t.length) return null;
  const shape = (s) => (/[\\/]|^[A-Za-z]:$/.test(s) ? '<path>' : s.length > 24 ? '<arg>' : s);
  return t.length === 1 ? shape(t[0]) : `${shape(t[0])} ${shape(t[1])}`;
}

// ---------------------------------------------------------------------------
// Sources -- anything yielding { header, rows, rel } can be aggregated
// ---------------------------------------------------------------------------

// The live logs, stripped in memory and thrown away. `rel` points at where pass 2 will
// materialise this session if a cluster ends up citing it.
export function* fromLive({ home = homedir(), roots = null, onProgress = null } = {}) {
  const sessions = groupLiveSessions({ home, roots });
  let n = 0;
  for (const [sessionId, files] of sessions) {
    const { header, rows } = stripSession(sessionId, files);
    if (onProgress) onProgress(++n, sessions.size);
    yield { header, rows, rel: `cache/evidence/${sessionId}.jsonl` };
  }
}

function* walkStripped(dir) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkStripped(p);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name !== 'index.jsonl') yield p;
  }
}

// A directory of already-stripped .jsonl files. Retained only so a run can be compared
// against a report generated from the retired committed corpus -- see --regress.
export function* fromStrippedDir(dir) {
  for (const file of walkStripped(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let header = null;
    const rows = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      if (r.v && r.sessionId) header = r;
      else rows.push(r);
    }
    if (header) yield { header, rows, rel: file.split(sep).join('/') };
  }
}

// ---------------------------------------------------------------------------
// Cluster accumulator
// ---------------------------------------------------------------------------
function bucket(map, key) {
  let b = map.get(key);
  if (!b) {
    b = { key, sessions: new Set(), occurrences: 0, skills: {}, repos: new Set(), evidence: [] };
    map.set(key, b);
  }
  return b;
}

function hit(b, { session, repo, skill, quote, file, extra }) {
  b.sessions.add(session);
  b.occurrences++;
  if (repo) b.repos.add(repo);
  const s = skill || '(none)';
  b.skills[s] = (b.skills[s] || 0) + 1;
  // One evidence item per session, so three items means three different days, not three
  // lines from the same bad afternoon.
  if (b.evidence.length < MAX_EVIDENCE && !b.evidence.some((e) => e.session === session)) {
    b.evidence.push({ session, file, quote: String(quote || '').slice(0, QUOTE), ...extra });
  }
}

const shape = (map, minSessions) =>
  [...map.values()]
    .filter((b) => b.sessions.size >= minSessions)
    .map((b) => ({
      key: b.key,
      sessions: b.sessions.size,
      occurrences: b.occurrences,
      repos: [...b.repos].slice(0, 5),
      skills: b.skills,
      evidence: b.evidence,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences);

// ---------------------------------------------------------------------------
// Skill inventory -- so a review can cross-check against EVERY skill, not just the one
// that happened to be loaded. That rule is the reference design's best idea, and a table
// is what makes it affordable: 40 rows instead of 40 file reads.
// ---------------------------------------------------------------------------
// The installed copies that actually load are under
// plugins/cache/<marketplace>/<plugin>/<version>/, NOT the marketplace dirs. Globbing only
// marketplaces/ matched 2 of 21 used skills.
function* walkSkillFiles(dir) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkSkillFiles(p);
    else if (e.name === 'SKILL.md') yield p;
  }
}

export function skillInventory(claude = CLAUDE) {
  const byName = new Map();
  const add = (name, path, ownership, version = '') => {
    const prev = byName.get(name);
    // Several versions of a plugin sit in cache/ side by side; the highest wins.
    if (prev && prev.version >= version && prev.ownership === ownership) return;
    byName.set(name, { name, path, ownership, version, sessions: 0, turns: 0, errors: 0, lastUsed: null });
  };

  for (const d of safeDirs(join(claude, 'skills'))) add(d, join(claude, 'skills', d, 'SKILL.md'), 'user');
  for (const f of safeFiles(join(claude, 'commands'))) {
    if (f.endsWith('.md')) add(basename(f, '.md'), join(claude, 'commands', f), 'user');
  }

  for (const p of walkSkillFiles(join(claude, 'plugins'))) {
    const parts = p.split(sep);
    const sk = parts[parts.length - 2];
    const si = parts.lastIndexOf('skills');
    if (si < 1) continue;
    // cache/<mkt>/<plugin>/<version>/skills/<sk>  |  marketplaces/<mkt>/plugins/<plugin>/skills/<sk>
    // marketplaces/<mkt>/skills/<sk>              |  marketplaces/<mkt>/<dot-dir>/skills/<sk>
    // Anchor on the marketplace segment, not on a fixed offset back from `skills`: the
    // depth varies (a `.claude/` level appears in some plugins, a version level in cache/),
    // and counting backwards produced "4.8.4:ponytail" -- the version as the plugin name.
    const ci = parts.indexOf('cache');
    const mi = parts.indexOf('marketplaces');
    let plug;
    if (ci !== -1) plug = parts[ci + 2]; // cache/<marketplace>/<plugin>/<version>/...
    else if (mi !== -1) {
      const pi = parts.indexOf('plugins', mi);
      plug = pi !== -1 && pi < si ? parts[pi + 1] : parts[mi + 1];
    } else continue;
    if (!plug) continue;
    const version = ci !== -1 ? parts[ci + 3] ?? '' : '';
    add(`${plug}:${sk}`, p, ci !== -1 ? 'plugin-installed' : 'plugin-source', version);
  }
  // A marketplace added from a folder on disk loads its plugins in place from that folder, but
  // `plugin install` still leaves a copy under cache/ -- and that copy, labelled
  // plugin-installed, would route every proposal to "never edit". Read the folder the harness
  // actually loads from; a different ownership label makes add() replace the cache row.
  let known = {};
  try {
    known = JSON.parse(readFileSync(join(claude, 'plugins', 'known_marketplaces.json'), 'utf8'));
  } catch {
    /* no plugins state yet */
  }
  for (const mkt of Object.values(known)) {
    if (mkt?.source?.source !== 'directory' || !mkt.source.path) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(mkt.source.path, '.claude-plugin', 'marketplace.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const p of manifest.plugins ?? []) {
      if (typeof p.source !== 'string') continue;
      const dir = resolve(mkt.source.path, p.source);
      for (const sk of safeDirs(join(dir, 'skills'))) {
        add(`${p.name}:${sk}`, join(dir, 'skills', sk, 'SKILL.md'), 'plugin-source');
      }
    }
  }
  return [...byName.values()];
}

const safeDirs = (d) => {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && statSync(join(d, e.name), { throwIfNoEntry: false })?.isDirectory()))
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const safeFiles = (d) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------
export function aggregate({ sessions, since = null, minSessions = 2 } = {}) {
  const errors = new Map();
  const commands = new Map();
  const denials = new Map();
  const causes = [];
  const prompts = [];
  const skillUse = new Map();
  const corpus = { sessions: 0, skipped: 0, toolCalls: 0, errorResults: 0, denials: 0, shellCalls: 0 };

  for (const { header, rows, rel } of sessions) {
    if (!header) continue;
    if (since && header.lastTs && header.lastTs < since) {
      corpus.skipped++;
      continue;
    }
    corpus.sessions++;
    const session = header.sessionId.slice(0, 8);
    const repo = header.cwd ? repoOf(header.cwd) : (header.projects?.[0] ?? '?');

    // tool_use id -> what it was, so an error result can name the tool and path that caused it
    const calls = new Map();
    let skill = null;

    for (const r of rows) {
      if (r.t === 'a') {
        if (r.sk !== undefined) skill = r.sk;
        for (const c of Array.isArray(r.c) ? r.c : []) {
          if (!c || !c.tool) continue;
          corpus.toolCalls++;
          calls.set(c.id, { tool: c.tool, path: c.in?.file_path, skill });
          if (c.tool === 'Bash' || c.tool === 'PowerShell') {
            corpus.shellCalls++;
            const k = commandKey(c.in?.command);
            if (k) hit(bucket(commands, k), { session, repo, skill, quote: c.in?.command, file: rel });
          }
        }
        if (r.sk) {
          const b = skillUse.get(r.sk) || { sessions: new Set(), turns: 0, errors: 0, lastUsed: null };
          b.sessions.add(session);
          b.turns++;
          if (r.ts && (!b.lastUsed || r.ts > b.lastUsed)) b.lastUsed = r.ts;
          skillUse.set(r.sk, b);
        }
      } else if (r.t === 'h') {
        // A plain typed turn resets skill attribution; a slash command sets it.
        if (r.hk === 'typed') {
          skill = null;
          const text = promptText(r.text);
          if (text) prompts.push({ session, repo, at: r.ts, text: text.slice(0, QUOTE) });
        }
      } else if (r.t === 'cause') {
        causes.push({ session, repo, at: r.ts, skill, text: r.text });
      } else if (r.t === 'u') {
        if (r.denial) {
          corpus.denials++;
          const call = calls.get(r.tr?.[0]?.id);
          const k = `${r.denial}:${call?.tool ?? '?'}`;
          hit(bucket(denials, k), {
            session, repo, skill, file: rel,
            quote: r.fb || r.tr?.[0]?.head || '',
            extra: { typedReason: !!r.fb },
          });
        }
        for (const tr of Array.isArray(r.tr) ? r.tr : []) {
          if (!tr.err) continue;
          corpus.errorResults++;
          const call = calls.get(tr.id);
          const k = errorKey(call?.tool ?? '?', tr.head);
          hit(bucket(errors, k), { session, repo, skill: call?.skill ?? skill, quote: tr.head, file: rel });
          if (call?.skill) {
            const b = skillUse.get(call.skill);
            if (b) b.errors++;
          }
        }
      }
    }
  }

  const inventory = skillInventory();
  // Join on the full `plugin:skill` name, then on the bare skill name -- attribution and
  // the on-disk layout do not always agree on the plugin prefix.
  const byName = new Map();
  for (const s of inventory) {
    byName.set(s.name, s);
    const bare = s.name.replace(/^[^:]+:/, '');
    if (!byName.has(bare)) byName.set(bare, s);
  }
  const unlisted = [];
  for (const [name, b] of skillUse) {
    const row = byName.get(name) || byName.get(name.replace(/^[^:]+:/, ''));
    if (row) {
      row.sessions = b.sessions.size;
      row.turns = b.turns;
      row.errors = b.errors;
      row.lastUsed = b.lastUsed;
    } else unlisted.push({ name, sessions: b.sessions.size, turns: b.turns, errors: b.errors, lastUsed: b.lastUsed });
  }

  return {
    corpus: {
      ...corpus,
      minSessions,
      since,
      // A fresh install must be told the corpus is too thin, not handed a thin review.
      belowFloor: corpus.sessions < MIN_SESSIONS_FOR_REVIEW,
      floor: MIN_SESSIONS_FOR_REVIEW,
    },
    errors: shape(errors, minSessions),
    // Habits are noisy -- one person's shell style produces dozens of low-count keys, so
    // this needs a higher bar than an error does.
    commands: shape(commands, Math.max(minSessions, 5)),
    // A typed rejection reason is deliberate, unambiguous correction, and there are few
    // enough that a single occurrence can never flood the review.
    denials: shape(denials, 1),
    causes,
    prompts,
    skills: inventory.filter((s) => s.sessions > 0).sort((a, b) => b.sessions - a.sessions),
    skillsUnused: inventory.filter((s) => s.sessions === 0).map((s) => s.name),
    skillsUnlisted: unlisted,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 -- materialise only the sessions the clusters actually cite
// ---------------------------------------------------------------------------

// Every evidence entry carries `session`, the first 8 chars of a sessionId. Collect the
// full ids those prefixes belong to, re-strip just those, and write them where the report
// says they are. Two passes rather than buffering the whole corpus: 18 MB of stripped text
// is ~200 MB as live objects, and re-reading ~24 files costs less than holding 102.
export function citedSessions(report) {
  const want = new Set();
  for (const group of [report.errors, report.commands, report.denials]) {
    for (const c of group || []) for (const e of c.evidence || []) want.add(e.session);
  }
  return want;
}

export function writeEvidence(report, { home = homedir(), roots = null, dest }) {
  const want = citedSessions(report);
  if (!want.size) return 0;
  const dir = join(dest, 'cache', 'evidence');
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [sessionId, files] of groupLiveSessions({ home, roots })) {
    if (!want.has(sessionId.slice(0, 8))) continue;
    writeFileSync(join(dir, `${sessionId}.jsonl`), serialize(stripSession(sessionId, files)));
    written++;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Regression check against a frozen report
// ---------------------------------------------------------------------------

// The committed corpus and the live logs currently hold the same sessions, so a report
// generated from the corpus is an exact baseline for one generated from the logs. That
// overlap ends when retention deletes the oldest sessions, which is why this check is worth
// running now rather than later.
//
// Growth is expected -- the live logs gain sessions the baseline never saw. A cluster that
// SHRANK or VANISHED is the bug signal, because the same evidence cannot support less.
export function compareReports(baseline, current) {
  const problems = [];
  const info = [];
  for (const group of ['errors', 'commands', 'denials']) {
    const now = new Map((current[group] || []).map((c) => [c.key, c]));
    for (const b of baseline[group] || []) {
      const c = now.get(b.key);
      if (!c) problems.push(`${group}: MISSING "${b.key}" (was ${b.sessions} sessions)`);
      else if (c.sessions < b.sessions) {
        problems.push(`${group}: SHRANK "${b.key}" ${b.sessions} -> ${c.sessions} sessions`);
      }
      now.delete(b.key);
    }
    if (now.size) info.push(`${group}: ${now.size} new cluster(s) not in the baseline`);
  }
  return { problems, info };
}

// ---------------------------------------------------------------------------
// Counting a candidate the model named
// ---------------------------------------------------------------------------
// Discovery stays with the model; this only makes its count re-runnable. That split is
// measured, not stylistic: a term table built over these turns and ranked by repo spread
// returns `the` (20 repos), `this` and `that` before it returns `worktree`, and a
// document-frequency ceiling cannot fix it because the real terms are MORE frequent than the
// junk (`worktree` 5.7% of turns, `hook` 7.4%, against `did` 2.7%, `still` 2.5%).
//
// Sessions and repos are reported separately and never folded into one score. Repo spread is
// what separates a reusable subtask from one project's quirk: in the reference corpus
// `worktree` spans 10 repos and `status ?line` spans 3, and the two OPEN new-skill findings
// got both numbers wrong by eye.
export function countTerm({ sessions, pattern, since = null }) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  const b = bucket(new Map(), String(pattern));
  for (const { header, rows, rel } of sessions) {
    if (!header) continue;
    if (since && header.lastTs && header.lastTs < since) continue;
    const session = header.sessionId.slice(0, 8);
    const repo = header.cwd ? repoOf(header.cwd) : (header.projects?.[0] ?? '?');
    for (const r of rows) {
      if (r.t !== 'h' || r.hk !== 'typed') continue;
      const text = promptText(r.text);
      if (!text || !re.test(text)) continue;
      hit(b, { session, repo, quote: text, file: rel });
    }
  }
  return {
    pattern: String(pattern),
    sessions: b.sessions.size,
    repos: b.repos.size,
    occurrences: b.occurrences,
    repoNames: [...b.repos].sort(),
    evidence: b.evidence,
  };
}

// ---------------------------------------------------------------------------
function parseSince(v) {
  if (!v) return null;
  const m = /^(\d+)([dh])$/.exec(v);
  if (!m) return v;
  const ms = Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
  return new Date(Date.now() - ms).toISOString();
}

function flag(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function selfCheck() {
  stripSelfCheck();

  // Error keys: the same cause with different paths, ids and numbers must collapse to one.
  const a = errorKey('Bash', 'Exit code 1\nmore detail');
  const b = errorKey('Bash', 'Exit code 2\ndifferent detail');
  assert.equal(a, b, 'exit codes must not split a cluster');
  assert.equal(
    errorKey('Read', 'File does not exist: C:\\dev\\a\\b.ts'),
    errorKey('Read', 'File does not exist: C:\\other\\c.ts'),
    'paths must not split a cluster',
  );
  assert.notEqual(errorKey('Read', 'File does not exist'), errorKey('Edit', 'File does not exist'), 'tool separates');
  assert.equal(errorKey('Bash', '\n\n  Exit code 1  '), 'Bash: Exit code N', 'leading blank lines skipped');
  assert.equal(errorKey('X', ''), 'X: ');
  assert.match(errorKey('Bash', 'failed at abcdef1234567890'), /<hex>/);

  // Command keys: same verb, different args -> one habit.
  assert.equal(commandKey('cd /a/b && ls'), commandKey('cd /c/d && pwd'));
  assert.equal(commandKey('cd /a/b && ls'), 'cd <path>');
  assert.equal(commandKey('git commit -m x'), 'git commit');
  assert.notEqual(commandKey('git commit -m x'), commandKey('git status'));
  assert.equal(commandKey('ls'), 'ls');
  assert.equal(commandKey('   '), null);

  // Thresholds: distinct sessions, never occurrences.
  const m = new Map();
  const b1 = bucket(m, 'k');
  hit(b1, { session: 's1', quote: 'x' });
  hit(b1, { session: 's1', quote: 'y' });
  hit(b1, { session: 's1', quote: 'z' });
  assert.equal(shape(m, 2).length, 0, 'three hits in ONE session is one session, below threshold');
  hit(b1, { session: 's2', quote: 'w' });
  assert.equal(shape(m, 2).length, 1);
  assert.equal(shape(m, 2)[0].sessions, 2);
  assert.equal(shape(m, 2)[0].occurrences, 4);
  assert.equal(shape(m, 2)[0].evidence.length, 2, 'one evidence item per session');

  // Pasted turns: structural markers only, never wording.
  assert.equal(promptText('<bash-stdout>Already up to date.</bash-stdout>'), null);
  assert.equal(promptText('<command-name>/clear</command-name>'), null);
  assert.equal(promptText('Read 1 file (ctrl+o to expand)'), null);
  assert.equal(promptText('/compact'), null, 'bare slash command is a UI action');
  assert.equal(promptText('/cæear'), null, 'non-ASCII slash command still a UI action');
  assert.equal(promptText('   '), null);
  assert.equal(
    promptText('Fix the bash-stdout parser'),
    'Fix the bash-stdout parser',
    'prose that merely mentions a marker is authored text',
  );
  assert.equal(
    promptText('/compact the review before we ship'),
    '/compact the review before we ship',
    'a slash word inside a sentence is not a slash command',
  );
  // An image marker is stripped, not a reason to drop the request carrying it.
  assert.equal(promptText('[Image #1] Is there any settings here?'), 'Is there any settings here?');
  assert.equal(promptText('[Image #2]'), null, 'a bare screenshot authors nothing');

  // countTerm: distinct sessions and distinct repos, counted separately.
  const turn = (text) => ({ t: 'h', hk: 'typed', text });
  const cSessions = [
    { header: { v: 1, sessionId: 'aaaaaaaa1', cwd: 'C:\\dev\\one' }, rel: 'f1',
      rows: [turn('open a worktree'), turn('the worktree again'), turn('unrelated')] },
    { header: { v: 1, sessionId: 'bbbbbbbb1', cwd: 'C:\\dev\\one' }, rel: 'f2',
      rows: [turn('WORKTREE trouble')] },
    { header: { v: 1, sessionId: 'cccccccc1', cwd: 'C:\\dev\\two' }, rel: 'f3',
      rows: [turn('<bash-stdout>fatal: already used by worktree</bash-stdout>')] },
  ];
  const c = countTerm({ sessions: cSessions, pattern: 'worktree' });
  assert.equal(c.sessions, 2, 'two authored sessions; the pasted git error is not a third');
  assert.equal(c.occurrences, 3, 'occurrences count every hit, sessions do not');
  assert.equal(c.repos, 1, 'both authored sessions are the same repo');
  assert.deepEqual(c.repoNames, ['one']);
  assert.equal(c.evidence.length, 2, 'one evidence item per session');
  assert.equal(countTerm({ sessions: cSessions, pattern: 'nothing-here' }).sessions, 0);
  // Repo count is distinct repos, not the truncated list shape() prints.
  const wide = Array.from({ length: 8 }, (_, i) => ({
    header: { v: 1, sessionId: `s${i}`, cwd: `C:\\dev\\r${i}` }, rel: `f${i}`, rows: [turn('worktree')],
  }));
  assert.equal(countTerm({ sessions: wide, pattern: 'worktree' }).repos, 8, 'repos are not capped at 5');

  // aggregate() over a hand-built source: no disk, no real logs.
  const session = (sessionId, rows, extra = {}) => ({
    header: { v: 1, sessionId, cwd: 'C:\\dev\\demo', lastTs: '2026-08-01T00:00:00Z', ...extra },
    rows,
    rel: `cache/evidence/${sessionId}.jsonl`,
  });
  const errRows = [
    { t: 'a', c: [{ tool: 'Bash', id: 'c1', in: { command: 'cd /x && ls' } }] },
    { t: 'u', tr: [{ id: 'c1', err: true, head: 'Exit code 1' }] },
  ];
  const rep = aggregate({ sessions: [session('aaaaaaaa1', errRows), session('bbbbbbbb2', errRows)] });
  assert.equal(rep.corpus.sessions, 2);
  assert.equal(rep.corpus.errorResults, 2);
  assert.equal(rep.errors.length, 1, 'one cluster across two sessions');
  assert.equal(rep.errors[0].sessions, 2);
  assert.equal(rep.errors[0].evidence[0].file, 'cache/evidence/aaaaaaaa1.jsonl', 'evidence points at pass 2');
  assert.equal(rep.corpus.belowFloor, true, 'two sessions is below the review floor');

  // `since` skips a session by its last timestamp rather than dropping it silently.
  const old = aggregate({ sessions: [session('cccccccc3', errRows, { lastTs: '2020-01-01T00:00:00Z' })], since: '2026-01-01T00:00:00Z' });
  assert.equal(old.corpus.sessions, 0);
  assert.equal(old.corpus.skipped, 1);

  // citedSessions pulls the 8-char prefixes pass 2 needs to materialise.
  assert.deepEqual([...citedSessions(rep)].sort(), ['aaaaaaaa', 'bbbbbbbb']);

  // Regression comparison: growth is fine, shrinkage and disappearance are not.
  const base = { errors: [{ key: 'Bash: Exit code N', sessions: 5 }], commands: [], denials: [] };
  assert.deepEqual(compareReports(base, { errors: [{ key: 'Bash: Exit code N', sessions: 7 }] }).problems, []);
  assert.match(
    compareReports(base, { errors: [{ key: 'Bash: Exit code N', sessions: 4 }] }).problems[0],
    /SHRANK/,
  );
  assert.match(compareReports(base, { errors: [] }).problems[0], /MISSING/);
  assert.equal(
    compareReports(base, { errors: [{ key: 'Bash: Exit code N', sessions: 5 }, { key: 'new', sessions: 9 }] }).info.length,
    1,
    'a new cluster is information, not a failure',
  );

  // scanOutput: a real leak is found, and the two things that make it a *useful* check --
  // it walks the durable output only, and it does not invent leaks out of encoded newlines.
  const dir = mkdtempSync(join(tmpdir(), 'scan-output-'));
  try {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'findings-and-decisions.jsonl'), JSON.stringify({ row: 'report', text: 'Authorization: Bearer sk-ant-abcdefgh12345678' }) + '\n');
    writeFileSync(join(dir, 'proposals-2026-08-21.md'), '# clean\nnothing here\n');
    writeFileSync(join(dir, 'cache', 'review-latest.json'), 'sk-ant-shouldnotbescanned1234');
    const bad = scanOutput(dir);
    assert.equal(bad.files, 2, 'only .jsonl and .md, and never cache/');
    assert.ok(bad.hits >= 1, 'a token in the ledger is found');

    // The un-escape: `\n@AGENTS.md` on disk must not read as the address `n@AGENTS.md`, and a
    // value already cut by the truncation marker must not report itself as a leak.
    writeFileSync(join(dir, 'findings-and-decisions.jsonl'), JSON.stringify({ row: 'report', text: 'read CLAUDE.md\n@AGENTS.md then apikey: …[+514]' }) + '\n');
    const clean = scanOutput(dir);
    assert.equal(clean.hits, 0, `encoded whitespace must not invent leaks: ${clean.found.join('; ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // A local-directory marketplace loads in place, but `plugin install` still leaves a copy under
  // cache/. The working copy must win, or a proposal is routed to "never edit".
  const fakeClaude = mkdtempSync(join(tmpdir(), 'inv-claude-'));
  const mkt = mkdtempSync(join(tmpdir(), 'inv-mkt-'));
  try {
    mkdirSync(join(mkt, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mkt, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'mine', plugins: [{ name: 'demo', source: './plugins/demo' }] }));
    mkdirSync(join(mkt, 'plugins', 'demo', 'skills', 'hello'), { recursive: true });
    writeFileSync(join(mkt, 'plugins', 'demo', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n');
    const cached = join(fakeClaude, 'plugins', 'cache', 'mine', 'demo', 'unknown', 'skills', 'hello');
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, 'SKILL.md'), '---\nname: hello\n---\n');
    writeFileSync(join(fakeClaude, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ mine: { source: { source: 'directory', path: mkt } } }));

    const row = skillInventory(fakeClaude).find((s) => s.name === 'demo:hello');
    assert.ok(row, 'the plugin skill is inventoried');
    assert.equal(row.ownership, 'plugin-source', 'the working copy wins over the cache copy');
    assert.equal(row.path, join(mkt, 'plugins', 'demo', 'skills', 'hello', 'SKILL.md'));
  } finally {
    rmSync(fakeClaude, { recursive: true, force: true });
    rmSync(mkt, { recursive: true, force: true });
  }

  console.log('ok');
}

// ---------------------------------------------------------------------------
// Output verification -- a second opinion on redact()
// ---------------------------------------------------------------------------

// Independent of the writer on purpose: re-apply SECRETS to what actually landed on disk, so a
// call site that forgot redact() cannot hide behind it. Scoped to the durable output -- the
// ledger and the proposals files -- because that is what gets committed and pushed. `cache/`
// is skipped: it is gitignored and rebuilt on every run, so it is never published.
export function scanOutput(dir) {
  const targets = [];
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (e.name !== 'cache') walk(join(d, e.name));
      } else if (/\.(jsonl|md)$/.test(e.name)) targets.push(join(d, e.name));
    }
  };
  walk(dir);

  let hits = 0;
  const found = [];
  for (const p of targets) {
    // Restore the whitespace JSON encoding hid. redact() matched against decoded strings,
    // where a newline is one whitespace char; on disk it is the two characters `\` `n`, so
    // every pattern relying on a whitespace boundary disagrees with the redactor that produced
    // the file. That mismatch invents leaks rather than finding them: `CLAUDE.md\n@AGENTS.md`
    // reads as the address `n@AGENTS.md`. Scan what redact() saw. Typed report prose makes
    // multi-line rows the common case here, so this is load-bearing, not incidental.
    const text = readFileSync(p, 'utf8').replace(/\\[nrt]/g, ' ');
    for (const re of SECRETS) {
      const m = text.match(new RegExp(re.source, re.flags.replace('g', '') + 'g'));
      if (!m) continue;
      for (const hit of m.slice(0, 3)) {
        found.push(`${basename(p)}: ${re.source.slice(0, 40)} -> ${hit.slice(0, 40)}`);
        hits++;
      }
    }
  }
  return { files: targets.length, hits, found };
}

// ---------------------------------------------------------------------------
// Guarded on being the entry point, not on argv alone: status.mjs imports outputDir() from
// here, and an argv-only guard would fall through to the `else` branch and run a full 51s
// aggregation as a side effect of the import.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

if (!isMain) {
  // imported as a module -- expose the functions, run nothing
} else if (argv.includes('--self-check')) {
  selfCheck();
} else if (argv.includes('--scan-output')) {
  // node review.mjs --scan-output [--dir <ledger dir>]
  // Run this before any push. The ledger and the proposals files keep your shell commands and
  // typed prose verbatim, and report.mjs writes prose typed while something was broken.
  const dir = flag('--dir') ?? outputDir();
  const { files, hits, found } = scanOutput(dir);
  for (const f of found) console.error(f);
  if (!files) console.log(`nothing to scan in ${dir}`);
  else console.log(hits ? `FAIL: ${hits} possible secrets in ${files} files` : `ok: no secrets found in ${files} files`);
  process.exitCode = hits ? 1 : 0;
} else if (argv.includes('--count')) {
  // node review.mjs --count worktree [--from <stripped-dir>] [--since 30d]
  // Prints the recurrence a proposal must cite. Anything not printed here is not a number.
  const pattern = flag('--count');
  const from = flag('--from');
  const sessions = from ? fromStrippedDir(from) : fromLive();
  if (!from) process.stderr.write('reading live transcripts (use --from <dir> for a stripped corpus)\n');
  const r = countTerm({ sessions, pattern, since: parseSince(flag('--since')) });
  console.log(`${r.pattern}   sessions=${r.sessions}  repos=${r.repos}  occurrences=${r.occurrences}`);
  console.log(`repos: ${r.repoNames.join(', ') || '(none)'}`);
  for (const e of r.evidence) console.log(`  ${e.session}  ${e.file}\n    "${e.quote.slice(0, 140)}"`);
  if (!r.sessions) process.exitCode = 1;
} else if (argv.includes('--regress')) {
  const baselinePath = flag('--regress');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  process.stderr.write(`clustering live transcripts to compare against ${baselinePath}\n`);
  const current = aggregate({
    sessions: fromLive({
      onProgress: (n, total) => {
        if (n % 25 === 0 || n === total) process.stderr.write(`  ${n}/${total} sessions\r`);
      },
    }),
  });
  process.stderr.write('\n');
  const { problems, info } = compareReports(baseline, current);
  for (const i of info) console.log(`info: ${i}`);
  for (const p of problems) console.error(`FAIL: ${p}`);
  console.log(
    problems.length
      ? `FAIL: ${problems.length} baseline cluster(s) lost`
      : `ok: every baseline cluster survives (${baseline.corpus?.sessions ?? '?'} baseline -> ${current.corpus.sessions} live sessions)`,
  );
  process.exitCode = problems.length ? 1 : 0;
} else {
  const dest = flag('--out') || outputDir();
  const roots = discoverRoots();
  if (!roots.length) {
    console.error(`no Claude Code transcripts found under ${homedir()} -- looked for .claude*/projects/`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`roots: ${roots.join(', ')}\n`);
    const out = aggregate({
      sessions: fromLive({
        onProgress: (n, total) => {
          if (n % 25 === 0 || n === total) process.stderr.write(`  stripped ${n}/${total} sessions\r`);
        },
      }),
      since: parseSince(flag('--since')),
      minSessions: Number(flag('--min-sessions', '2')),
    });
    process.stderr.write('\n');

    mkdirSync(join(dest, 'cache'), { recursive: true });
    const reportPath = join(dest, 'cache', 'review-latest.json');
    writeFileSync(reportPath, JSON.stringify(out, null, 1) + '\n');

    if (out.corpus.belowFloor) {
      console.error(
        `only ${out.corpus.sessions} sessions found; a review needs at least ${out.corpus.floor} ` +
          `to tell a recurring problem from a coincidence. Nothing is wrong -- come back after more use.`,
      );
    } else {
      const n = writeEvidence(out, { dest });
      console.error(
        `${out.corpus.sessions} sessions | ${out.errors.length} error clusters | ` +
          `${out.commands.length} habits | ${out.denials.length} denials | ${out.causes.length} causes | ` +
          `${n} evidence files -> ${reportPath}`,
      );
    }
  }
}
