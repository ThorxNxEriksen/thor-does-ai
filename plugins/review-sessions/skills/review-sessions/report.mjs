#!/usr/bin/env node
// File one raw report about your Claude Code setup, at the moment you hit the problem.
//
// Capture only. It asks nothing, diagnoses nothing and fixes nothing. A report is an inbox
// row that phase 1 later turns into a finding, and the whole point is that filing costs five
// seconds on a bad day -- the moment this script wants a `target` or a `proposal` from you, it
// stops getting used.
//
// The gap it fills: every other signal this skill has comes from something that happened
// *inside* a task -- a tool error, a denial, a `Cause:` line. A setup problem you noticed with
// your eyes (an MCP dropping auth, a hook firing twice) fails outside any task, leaves no trace
// in any transcript, and is invisible to the review. That matters more here than it looks:
// Claude Code deletes transcripts after ~30 days, so an unfiled problem is not merely
// unrecorded, it is unrecoverable.
//
//   node report.mjs "notion MCP dropped auth mid-session"
//   node report.mjs --text-file note.txt --raw error.txt
//   node report.mjs "..." --cwd C:/dev/other-repo --dir <ledger dir>
//   node report.mjs --self-check
//
// Ids are R-YYYY-MM-DD-NN. They share the ledger with findings, so the `R-` prefix is what
// keeps the two id namespaces apart and lets one decision row close either kind.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { redact } from './strip.mjs';
import { outputDir } from './review.mjs';
import { LEDGER } from './status.mjs';

// Torn last lines are expected in an append-only log that is written while being read.
function readRows(store) {
  if (!existsSync(store)) return [];
  const rows = [];
  for (const line of readFileSync(store, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

// Only report rows count. Findings in the same ledger carry bare `2026-08-21-01` ids, and
// counting those would make the first report of the day collide with them.
export function nextId(rows, date) {
  const n = rows.filter((r) => typeof r.id === 'string' && r.id.startsWith(`R-${date}-`)).length + 1;
  return `R-${date}-${String(n).padStart(2, '0')}`;
}

// Redaction happens here, before the line reaches disk, not in a scan afterwards. A report
// about a broken MCP is the likeliest place in this whole system to paste a live bearer
// token. `review.mjs --scan-output` re-checks the ledger afterwards, but as a backstop for a
// pattern this missed -- not as the first line of defence.
export function buildRow(rows, { text, raw, session, cwd, at }) {
  const row = {
    // `row` is the ledger's discriminator, not `kind` -- findings already use `kind` for
    // improve | new | simplify, and overloading it would make that value unreadable.
    row: 'report',
    id: nextId(rows, at.slice(0, 10)),
    at,
    session: session ?? null,
    cwd: cwd ?? null,
    // Approximate: the basename of the cwd, not the git toplevel. Close enough to cluster
    // by, and it costs no subprocess.
    repo: cwd ? basename(cwd.replace(/[\\/]+$/, '')) : null,
    text: redact(text),
  };
  if (raw) row.raw = redact(raw);
  return row;
}

export function fileReport(store, fields) {
  mkdirSync(join(store, '..'), { recursive: true });
  const row = buildRow(readRows(store), fields);
  appendFileSync(store, JSON.stringify(row) + '\n');
  return row;
}

// Commit with an explicit pathspec. `git commit -- <path>` ignores whatever else is staged, so
// filing a report from an unrelated session can never sweep up work in progress that someone
// else left in that tree.
//
// The ledger is only committed when it happens to live in a git repo -- which is the point of
// pointing CLAUDE_REVIEW_DIR at one. Outside a repo the row is still on disk; it is just not
// durable, and that is said out loud rather than silently.
export function commit(dir, row) {
  const gitAt = (cwd) => (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
  let top;
  try {
    top = gitAt(dir)('rev-parse', '--show-toplevel').trim();
  } catch {
    return 'not in a git repository -- on disk but uncommitted';
  }
  // spec is relative to top, so every git call below must run with -C top too -- -C dir would
  // resolve it against the wrong directory whenever dir is a subdirectory of the repo, which is
  // the normal case (CLAUDE_REVIEW_DIR is rarely the repo root itself).
  const git = gitAt(top);
  const spec = relative(top, join(dir, LEDGER)).replace(/\\/g, '/');
  const flat = row.text.replace(/\s+/g, ' ').trim();
  const subject = flat.length > 60 ? `${flat.slice(0, 60).replace(/\s+\S*$/, '')}…` : flat;
  try {
    git('add', '--', spec);
    git('commit', '-m', `Report ${row.id}: ${subject}`, '--', spec);
    return 'committed';
  } catch (e) {
    return `commit failed, row is on disk: ${(e.stderr || e.message || '').trim().split('\n')[0]}`;
  }
}

function parse(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-commit') opts.noCommit = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

function main(argv) {
  const o = parse(argv);
  // Prose you typed and pasted error output both have to survive verbatim, so both can arrive
  // as a file path rather than an argument.
  const text = o['text-file'] ? readFileSync(o['text-file'], 'utf8').trim() : o.positional.join(' ').trim();
  if (!text) {
    console.error('nothing to report. Pass the text as an argument or --text-file <path>.');
    return 1;
  }
  // --dir mirrors status.mjs's --dir and review.mjs's --out.
  const dir = o.dir ?? outputDir();
  const row = fileReport(join(dir, LEDGER), {
    text,
    raw: o.raw ? readFileSync(o.raw, 'utf8') : undefined,
    session: o.session,
    cwd: o.cwd ?? process.cwd(),
    at: new Date().toISOString(),
  });
  const state = o.noCommit ? 'not committed (--no-commit)' : commit(dir, row);
  console.log(`${row.id} filed (${state})`);
  console.log('open until a decision row names it. `node status.mjs` lists it.');
  return 0;
}

// ---------------------------------------------------------------------------
// Self-check -- a temp ledger, never the real one
// ---------------------------------------------------------------------------
function selfCheck() {
  const dir = mkdtempSync(join(tmpdir(), 'report-selfcheck-'));
  const store = join(dir, 'nested', LEDGER);
  try {
    // Ids number within a day and ignore other days.
    assert.equal(nextId([], '2026-08-21'), 'R-2026-08-21-01');
    assert.equal(nextId([{ id: 'R-2026-08-21-01' }, { id: 'R-2026-08-21-02' }], '2026-08-21'), 'R-2026-08-21-03');
    assert.equal(nextId([{ id: 'R-2026-08-20-01' }], '2026-08-21'), 'R-2026-08-21-01');
    // Findings share the ledger and must not be counted as reports.
    assert.equal(nextId([{ row: 'finding', id: '2026-08-21-01' }], '2026-08-21'), 'R-2026-08-21-01');

    // A first report creates the directory and the file.
    const a = fileReport(store, { text: 'notion MCP dropped auth', cwd: 'C:/dev/other-repo', session: 'u1', at: '2026-08-21T09:00:00.000Z' });
    assert.equal(a.id, 'R-2026-08-21-01');
    assert.equal(a.row, 'report', 'the ledger discriminator is `row`');
    assert.equal(a.repo, 'other-repo');

    // Prose survives verbatim, including the quotes and newlines that break argument passing.
    const messy = 'it said "no such tool"\nthen hung\ttab';
    const b = fileReport(store, { text: messy, cwd: 'C:/dev/x/', at: '2026-08-21T09:01:00.000Z' });
    assert.equal(b.text, messy, 'text must round-trip through JSONL unchanged');
    assert.equal(b.repo, 'x', 'a trailing separator must not become the repo name');

    const rows = readRows(store);
    assert.deepEqual(rows.map((r) => r.id), ['R-2026-08-21-01', 'R-2026-08-21-02']);

    // A torn final line costs that row only.
    appendFileSync(store, '{"row":"report","id":"R-2026-08-21-03","at":"2026');
    assert.equal(readRows(store).length, 2, 'a torn line is skipped, not fatal');
    assert.equal(nextId(readRows(store), '2026-08-21'), 'R-2026-08-21-03');

    // The reason this redacts on write: an MCP auth error is where a live token shows up.
    const leak = fileReport(store, {
      text: 'MCP failed with Authorization: Bearer sk-ant-abc123def456xyz',
      raw: 'GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa\n',
      cwd: 'C:/dev/x',
      at: '2026-08-21T09:02:00.000Z',
    });
    assert.equal(leak.text.includes('sk-ant-abc123'), false, 'a token in the prose must not reach disk');
    assert.equal(leak.raw.includes('ghp_aaaaaaaaaaaaaaaaaaaa'), false, 'a token in pasted output must not reach disk');
    assert.equal(readFileSync(store, 'utf8').includes('sk-ant-abc123'), false, 'nor the file itself');
    assert.ok(leak.text.includes('MCP failed'), 'redaction must keep the report readable');

    // Third-party PII goes too, via the same table strip.mjs uses.
    const pii = fileReport(store, { text: 'asked alice@example.com to retry', cwd: 'C:/dev/x', at: '2026-08-21T09:03:00.000Z' });
    assert.equal(pii.text.includes('alice@example.com'), false, 'addresses are redacted with the shared table');

    // Nothing above touched the real ledger.
    assert.notEqual(resolve(store), resolve(join(outputDir(), LEDGER)));

    // Outside a git repo this reports rather than throwing.
    assert.match(commit(dir, { id: 'R-x', text: 't' }), /not in a git repository|commit failed/);

    console.log('ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // A real commit, with `dir` a SUBDIRECTORY of the repo -- the normal case, since
  // CLAUDE_REVIEW_DIR is rarely the repo root itself. Caught a real bug: `-C dir` on the
  // add/commit calls resolved a spec computed relative to `top`, so this failed on every
  // real-world layout and only ever "passed" against a bare non-repo temp dir.
  const repo = mkdtempSync(join(tmpdir(), 'report-selfcheck-repo-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    // mkdtempSync can return an 8.3 short-name path (USERNA~1) on Windows, while git normalizes
    // to the long form. Re-derive from git itself so `sub` matches what `top` resolves to inside
    // commit() -- otherwise `relative(top, sub)` walks out of the repo on a name it never left.
    const repoReal = git('rev-parse', '--show-toplevel').trim();
    const sub = join(repoReal, 'reviews');
    const store = join(sub, LEDGER);
    const row = fileReport(store, { text: 'real commit test', cwd: 'C:/dev/x', at: '2026-08-21T09:04:00.000Z' });
    const state = commit(sub, row);
    assert.equal(state, 'committed', `commit must succeed when dir is a subdirectory of the repo, got: ${state}`);
    // --stat always appends a "N file(s) changed" summary line after the per-file lines.
    const lines = git('show', '--stat', '--format=', 'HEAD').trim().split('\n');
    const summary = lines.pop();
    assert.equal(lines.length, 1, 'the commit must touch only the ledger');
    assert.match(lines[0], /reviews[\\/]findings-and-decisions\.jsonl/, 'the commit must touch the ledger');
    assert.match(summary, /1 file changed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Importable: no dispatch at module scope. `import`ing this file must never file a report.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-check')) selfCheck();
  else process.exitCode = main(process.argv.slice(2));
}
