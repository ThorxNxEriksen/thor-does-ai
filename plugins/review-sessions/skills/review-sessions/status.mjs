#!/usr/bin/env node
// Current status of every finding, as a fold over one append-only log.
//
// Nothing is ever mutated. Absence of a decision row IS "open" -- that is the whole design,
// and it is why "work on this later" means writing nothing rather than inventing a
// `deferred` state.
//
// This is phase 2's entry point. It is deliberately a separate script from review.mjs:
// review.mjs re-clusters the entire corpus (~51s), which is exactly the wrong thing to do
// when the question is "what is still open" and the proposals are already written.
//
// Verify with: node status.mjs --self-check

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { outputDir } from './review.mjs';

export const LEDGER = 'findings-and-decisions.jsonl';

function read(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// `row` discriminates the two shapes. It is not `kind`, which findings already use for
// improve | new | simplify -- overloading that would make the existing value unreadable.
export function fold(rows) {
  const findings = rows.filter((r) => r.row === 'finding');
  // Reports are filed by hand with report.mjs, so they arrive with no target, proposal or
  // principle -- deriving those is phase 1's job. They close through the same decision rows
  // as findings, which is why their ids carry an `R-` prefix rather than a separate log.
  const reports = rows.filter((r) => r.row === 'report');
  const latest = new Map();
  for (const d of rows) {
    if (d.row !== 'decision') continue;
    const prev = latest.get(d.obs);
    if (!prev || d.at >= prev.at) latest.set(d.obs, d);
  }
  const counts = { open: 0, actioned: 0, declined: 0 };
  const settle = (r) => {
    const status = latest.get(r.id)?.decision ?? 'open';
    counts[status] = (counts[status] ?? 0) + 1;
    return { ...r, status, decision: latest.get(r.id) ?? null };
  };
  return { findings: findings.map(settle), reports: reports.map(settle), counts };
}

function selfCheck() {
  const rows = [
    { row: 'finding', id: 'a', kind: 'improve', recurrence: { sessions: 3 }, target: { name: 'x' }, principle: 'p' },
    { row: 'finding', id: 'b', kind: 'new', recurrence: { sessions: 7 }, target: { name: 'y' }, principle: 'q' },
    { row: 'decision', obs: 'a', at: '2026-01-01T00:00:00Z', decision: 'declined' },
    // A later decision supersedes an earlier one; nothing is rewritten.
    { row: 'decision', obs: 'a', at: '2026-02-01T00:00:00Z', decision: 'actioned' },
  ];
  const { findings, counts } = fold(rows);
  assert.equal(findings.length, 2, 'decision rows are not findings');
  assert.equal(findings.find((f) => f.id === 'a').status, 'actioned', 'newest decision wins');
  assert.equal(findings.find((f) => f.id === 'b').status, 'open', 'no decision row means open');
  assert.deepEqual(counts, { open: 1, actioned: 1, declined: 0 });

  // `kind` must survive untouched -- the discriminator is `row`.
  assert.equal(findings.find((f) => f.id === 'b').kind, 'new');

  // A torn final line is normal in an append-only log and must not throw.
  assert.equal(fold([{ row: 'finding', id: 'c', kind: 'improve', recurrence: {}, target: {}, principle: '' }]).findings.length, 1);

  // Reports share the log and the decision rows, but never the findings list.
  const mixed = fold([
    ...rows,
    { row: 'report', id: 'R-2026-08-21-01', at: '2026-08-21T09:00:00Z', repo: 'other-repo', text: 'notion MCP dropped auth' },
    { row: 'report', id: 'R-2026-08-21-02', at: '2026-08-21T09:01:00Z', repo: 'x', text: 'hook fired twice' },
    { row: 'decision', obs: 'R-2026-08-21-02', at: '2026-08-22T00:00:00Z', decision: 'declined' },
  ]);
  assert.equal(mixed.findings.length, 2, 'a report is not a finding');
  assert.equal(mixed.reports.length, 2);
  assert.equal(mixed.reports[0].status, 'open', 'a filed report starts open');
  assert.equal(mixed.reports[1].status, 'declined', 'one decision row closes either kind');
  assert.deepEqual(mixed.counts, { open: 2, actioned: 1, declined: 1 }, 'reports are counted with findings');

  console.log('ok');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-check')) {
    selfCheck();
  } else {
    // --dir mirrors review.mjs's --out, so a ledger somewhere other than the default can be
    // folded without setting an environment variable.
    const i = process.argv.indexOf('--dir');
    const dir = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : outputDir();
    const path = join(dir, LEDGER);
    const rows = read(path);
    if (!rows.length) {
      console.log(`nothing yet -- ${path} is empty or absent. Run review.mjs, or file a report.`);
    } else {
      const { findings, reports, counts } = fold(rows);
      const line = (id, status, kind, count, where, text) =>
        console.log([String(id).padEnd(15), status.toUpperCase().padEnd(8), kind.padEnd(7), String(count).padStart(4), String(where).padEnd(22), text].join('  '));
      for (const f of findings) {
        line(f.id, f.status, String(f.kind ?? '?'), `${f.recurrence?.sessions ?? '?'}s`, f.target?.name ?? '?', f.principle ?? '');
      }
      for (const r of reports) {
        // The count column reads "-", not "1s". A report was witnessed once; a finding was
        // inferred from a cluster. Printing "1s" would blur two different kinds of evidence.
        line(r.id, r.status, 'report', '-', r.repo ?? '?', String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90));
      }
      const openReports = reports.filter((r) => r.status === 'open').length;
      console.log(
        `\n${findings.length + reports.length} items: ${counts.open} open, ${counts.actioned} actioned, ${counts.declined} declined` +
          (openReports ? `  (${openReports} filed report${openReports === 1 ? '' : 's'} not yet reviewed)` : ''),
      );
    }
  }
}
