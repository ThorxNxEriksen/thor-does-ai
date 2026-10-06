#!/usr/bin/env node
// Refuses to publish anything that identifies the author, the author's employer or its customers,
// or that looks like a credential. Run by .githooks/pre-push and by CI over the same commits.
//
//   node scripts/privacy-check.mjs --range <base>..<head>  added lines, file names, metadata of those commits
//   node scripts/privacy-check.mjs --new <sha>             commits reachable from <sha>, on no remote
//   node scripts/privacy-check.mjs --history <sha>         every commit reachable from <sha>
//   node scripts/privacy-check.mjs --ref <name> [--sha <sha>]  the pushed ref's name, and a tag's message
//   node scripts/privacy-check.mjs --all                   every tracked file and its name, in full
//   node scripts/privacy-check.mjs --self-check
//   ... --no-denylist   skip the denylist rule (CI uses it on fork PRs, where secrets are absent)
//
// History, not the tree: a value committed and removed in the next commit is still published.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECRETS } from '../plugins/review-sessions/skills/review-sessions/strip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOW_FILE = 'privacy-allow.txt';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const HOME_PATH = /(?<![\w.-])(?:\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)/g;
const PLACEHOLDER_USERS = new Set(['x', 'me', 'you', 'user', 'username', 'name', 'runner']);
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const OK_EMAIL = /noreply|@example\.(?:com|org|net)$|\.invalid$/i;

// A denylist entry is a case-insensitive substring, or with a `w:` prefix a whole word: no letter
// or digit directly on either side. Short customer names need the second form or they fire inside
// ordinary words ("ORB" in "absorb").
const wordRe = (t) => new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');

export function findHits(line, { deny = [], allow = [] } = {}) {
  const hits = [];
  const lower = line.toLowerCase();
  deny.forEach((term, i) => {
    const whole = term.startsWith('w:');
    const t = (whole ? term.slice(2) : term).toLowerCase();
    if (whole ? wordRe(t).test(lower) : lower.includes(t)) hits.push({ rule: 'denylist', text: `entry #${i + 1}` });
  });
  for (const re of SECRETS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    for (const m of line.matchAll(new RegExp(re.source, flags))) {
      const isEmail = EMAIL.test(m[0]);
      if (isEmail && OK_EMAIL.test(m[0])) continue;
      hits.push({ rule: isEmail ? 'email' : 'secret', text: m[0] });
    }
  }
  for (const m of line.matchAll(HOME_PATH)) {
    if (!PLACEHOLDER_USERS.has(m[1].toLowerCase())) hits.push({ rule: 'home-path', text: m[0] });
  }
  return hits.filter((h) => h.rule === 'denylist' || !allow.some((a) => h.text.includes(a)));
}

// `git show --unified=0` output -> the added lines, with the file and new line number of each.
// Header lines are only recognised between `diff --git` and the first `@@`, so an added line that
// itself starts with "++" is content, not a header.
export function addedLines(diff) {
  const out = [];
  let file = null;
  let n = 0;
  let inHeader = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader && l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? null : l.slice(6);
      continue;
    }
    if (l.startsWith('@@')) {
      inHeader = false;
      n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
      continue;
    }
    if (!inHeader && file && l.startsWith('+')) {
      out.push({ file, line: n, text: l.slice(1) });
      n++;
    }
  }
  return out;
}

const parseList = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

export function loadDenylist({ env = process.env, cwd = ROOT } = {}) {
  if (env.PRIVACY_DENYLIST) return parseList(env.PRIVACY_DENYLIST);
  let path = '';
  try {
    path = git(['config', '--type=path', '--get', 'thor.denylist'], cwd).trim();
  } catch {
    return null;
  }
  return path && existsSync(path) ? parseList(readFileSync(path, 'utf8')) : null;
}

export function loadAllow(root = ROOT) {
  const p = join(root, ALLOW_FILE);
  if (!existsSync(p)) return [];
  const lits = parseList(readFileSync(p, 'utf8'));
  for (const l of lits) {
    if (l.length < 8) throw new Error(`${ALLOW_FILE}: "${l}" is shorter than 8 characters -- too broad to allow`);
  }
  return lits;
}

export function scanCommits(shas, { cwd = ROOT, deny = [], allow = [] } = {}) {
  const hits = [];
  for (const sha of shas) {
    const meta = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', sha], cwd).split('\n');
    meta.forEach((text, i) => {
      for (const h of findHits(text, { deny, allow })) hits.push({ ...h, file: `commit ${sha.slice(0, 8)}`, line: i + 1, src: text });
    });
    // A merge is diffed against its first parent, so a hand-edited conflict resolution is scanned
    // like any other change. privacy-allow.txt is scanned too: its own lines contain their own
    // literals, so only a denylist hit can fire there -- which is exactly the one that must.
    const diff = git(['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--diff-merges=first-parent', sha], cwd);
    for (const { file, line, text } of addedLines(diff)) {
      for (const h of findHits(text, { deny, allow })) hits.push({ ...h, file: `${file} (${sha.slice(0, 8)})`, line, src: text });
    }
    const paths = git(['show', '--format=', '--name-only', '--diff-merges=first-parent', sha], cwd).split('\n').filter(Boolean);
    for (const p of paths) {
      for (const h of findHits(p, { deny, allow })) hits.push({ ...h, file: `path ${p} (${sha.slice(0, 8)})`, line: 0, src: p });
    }
  }
  return hits;
}

// range: <a>..<b>. fresh: reachable from <sha> and on no remote (the hook's first push of a
// branch). history: everything reachable from <sha> -- CI on a first push, where the remote
// already has the commits and `fresh` would list nothing.
export function listCommits({ range, fresh, history, cwd = ROOT }) {
  const args = range ? ['rev-list', range]
    : fresh ? ['rev-list', fresh, '--not', '--remotes']
      : ['rev-list', history];
  return git(args, cwd).split('\n').filter(Boolean);
}

// A pushed ref publishes its own name, and an annotated tag publishes its message and tagger.
export function scanRef(ref, sha, { cwd = ROOT, deny = [], allow = [] } = {}) {
  const hits = findHits(ref, { deny, allow }).map((h) => ({ ...h, file: `ref ${ref}`, line: 0, src: ref }));
  if (sha && git(['cat-file', '-t', sha], cwd).trim() === 'tag') {
    git(['cat-file', '-p', sha], cwd).split('\n').forEach((text, i) => {
      for (const h of findHits(text, { deny, allow })) hits.push({ ...h, file: `tag ${ref}`, line: i + 1, src: text });
    });
  }
  return hits;
}

function scanTree({ cwd, deny, allow }) {
  const hits = [];
  for (const file of git(['ls-files'], cwd).split('\n').filter(Boolean)) {
    for (const h of findHits(file, { deny, allow })) hits.push({ ...h, file: `path ${file}`, line: 0, src: file });
    const buf = readFileSync(join(cwd, file));
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split('\n').forEach((text, i) => {
      for (const h of findHits(text, { deny, allow })) hits.push({ ...h, file, line: i + 1, src: text });
    });
  }
  return hits;
}

function selfCheck() {
  // Fixtures are assembled at runtime so this file never contains a literal that trips the check.
  const KEY = 'sk-' + 'ant-' + 'live0123456789abcd';
  const HOME = '/Us' + 'ers/' + 'someone/';
  const CORP_MAIL = 'bob@' + 'corp' + '.dk';

  assert.deepEqual(findHits('plain text, nothing here'), []);
  assert.equal(findHits(`token ${KEY}`)[0]?.rule, 'secret', 'a key shape is found');
  assert.equal(findHits(`cd ${HOME}dev`)[0]?.rule, 'home-path', 'a real home path is found');
  assert.deepEqual(findHits('see /Users/x/project and /home/me/repo'), [], 'placeholder users pass');
  assert.deepEqual(findHits('claude-perfection/home/claude/settings.json'), [],
    'a repo folder named home is not a home directory');
  assert.equal(findHits(`mail ${CORP_MAIL}`)[0]?.rule, 'email', 'a real address is found');
  assert.deepEqual(findHits('alice@example.com, ci@runner.invalid'), [], 'example addresses pass');
  assert.deepEqual(findHits('Co-Authored-By: Claude <noreply@anthropic.com>'), [], 'noreply passes');
  assert.deepEqual(findHits('127940457+someone@users.noreply.github.com'), [], 'GitHub noreply passes');
  assert.equal(findHits('We work with ACME daily', { deny: ['acme'] })[0]?.rule, 'denylist',
    'denylist matching is case-insensitive');
  assert.deepEqual(findHits(`fixture ${KEY}`, { allow: [KEY] }), [], 'an allowlisted literal passes');
  assert.equal(findHits('acme', { deny: ['acme'], allow: ['acme fixture text'] }).length, 1,
    'a denylist hit can never be allowlisted');
  // `w:` entries match whole words only, so a short customer name does not fire inside prose.
  assert.deepEqual(findHits('we absorb it', { deny: ['w:orb'] }), [], 'a w: term does not match inside a word');
  assert.equal(findHits('ORB shipped it', { deny: ['w:orb'] }).length, 1, 'a w: term matches as a word');
  assert.equal(findHits('see Ødegårdø.', { deny: ['w:ødegårdø'] }).length, 1, 'word boundaries are Unicode-aware');
  assert.deepEqual(findHits('xødegårdøy', { deny: ['w:ødegårdø'] }), [], 'letters on either side block a w: match');
  assert.equal(findHits('Smith & Sons+ order', { deny: ['w:smith & sons+'] }).length, 1,
    'regex characters in a name are literal');

  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -0,0 +3,2 @@',
    '+first added',
    '++++ looks like a header but is content',
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed',
  ].join('\n');
  assert.deepEqual(addedLines(diff), [
    { file: 'a.txt', line: 3, text: 'first added' },
    { file: 'a.txt', line: 4, text: '+++ looks like a header but is content' },
  ]);

  assert.deepEqual(loadDenylist({ env: { PRIVACY_DENYLIST: '# comment\nAcme\n\n  Globex \n' } }),
    ['Acme', 'Globex']);

  const repo = mkdtempSync(join(tmpdir(), 'privacy-'));
  try {
    const g = (...a) => git(a, repo);
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'ci@runner.invalid');
    g('config', 'user.name', 'ci');
    g('config', 'commit.gpgsign', 'false');

    assert.equal(loadDenylist({ env: {}, cwd: repo }), null, 'no env and no git config -> null');
    writeFileSync(join(repo, 'deny.txt'), 'globex\n');
    g('config', 'thor.denylist', join(repo, 'deny.txt'));
    assert.deepEqual(loadDenylist({ env: {}, cwd: repo }), ['globex'], 'read through git config');

    writeFileSync(join(repo, ALLOW_FILE), 'short\n');
    assert.throws(() => loadAllow(repo), /shorter than 8/, 'a short allow literal is too broad');

    writeFileSync(join(repo, 'f.txt'), 'clean\n');
    g('add', 'f.txt');
    g('commit', '-q', '-m', 'clean');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'f.txt'), `clean\n${KEY}\n`);
    g('commit', '-q', '-am', 'leak');
    writeFileSync(join(repo, 'f.txt'), 'clean\n');
    g('commit', '-q', '-am', 'remove the leak');
    g('-c', `user.email=${CORP_MAIL}`, 'commit', '-q', '--allow-empty', '-m', 'mentions Globex');

    const shas = g('rev-list', '--no-merges', `${base}..HEAD`).trim().split('\n');
    const hits = scanCommits(shas, { cwd: repo, deny: ['globex'] });
    assert.ok(hits.some((h) => h.rule === 'secret' && h.file.startsWith('f.txt ')),
      'a leak removed in a later commit is still found');
    assert.ok(hits.some((h) => h.rule === 'email' && h.file.startsWith('commit ')),
      'commit author metadata is scanned');
    assert.ok(hits.some((h) => h.rule === 'denylist' && h.file.startsWith('commit ')),
      'commit messages are scanned');

    // Names travel outside line content too: in merge messages, file names, branch names and tag
    // messages. A second term keeps these hits apart from the ones above.
    const mark = g('rev-parse', 'HEAD').trim();
    g('checkout', '-q', '-b', 'initech-poc');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    g('add', 'b.txt');
    g('commit', '-q', '-m', 'feature');
    g('checkout', '-q', 'main');
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    g('add', 'c.txt');
    g('commit', '-q', '-m', 'other');
    g('merge', '-q', '--no-edit', 'initech-poc');
    const mergeSha = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'notes-initech.txt'), 'clean\n');
    g('add', 'notes-initech.txt');
    g('commit', '-q', '-m', 'add notes');
    writeFileSync(join(repo, ALLOW_FILE), 'initech fixture literal\n');
    g('add', ALLOW_FILE);
    g('commit', '-q', '-m', 'allow');

    const later = listCommits({ range: `${mark}..HEAD`, cwd: repo });
    assert.ok(later.includes(mergeSha), 'merge commits are listed, not skipped');
    const h2 = scanCommits(later, { cwd: repo, deny: ['initech'] });
    assert.ok(h2.some((h) => h.rule === 'denylist' && h.file === `commit ${mergeSha.slice(0, 8)}`),
      'a merge commit message is scanned');
    assert.ok(h2.some((h) => h.rule === 'denylist' && h.file.startsWith('path notes-initech.txt')),
      'a file name is scanned');
    assert.ok(h2.some((h) => h.rule === 'denylist' && h.file.startsWith(`${ALLOW_FILE} `)),
      'privacy-allow.txt is scanned for denylist terms');

    g('tag', '-a', 'v1', '-m', 'release for Initech');
    assert.ok(scanRef('refs/heads/initech-poc', null, { cwd: repo, deny: ['initech'] }).some((h) => h.rule === 'denylist'),
      'a pushed ref name is scanned');
    assert.ok(scanRef('refs/tags/v1', g('rev-parse', 'v1').trim(), { cwd: repo, deny: ['initech'] }).some((h) => h.rule === 'denylist'),
      'an annotated tag message is scanned');
    assert.deepEqual(scanRef('refs/heads/main', mergeSha, { cwd: repo, deny: ['initech'] }), [],
      'a commit is not read as a tag');

    const everything = listCommits({ history: 'HEAD', cwd: repo });
    assert.ok(everything.includes(base) && everything.includes(mergeSha),
      'history mode lists every commit from the root, merges included -- what CI needs on a first push');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  return 'privacy-check: ok';
}

function main(argv) {
  if (argv.includes('--self-check')) {
    console.log(selfCheck());
    return 0;
  }
  const arg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  let deny = [];
  if (!argv.includes('--no-denylist')) {
    deny = loadDenylist();
    if (!deny) {
      console.error('privacy-check: no denylist. Run `git config thor.denylist <path to your private list>` '
        + '(or set PRIVACY_DENYLIST). Refusing to run without it.');
      return 2;
    }
  }
  const allow = loadAllow();
  const opts = { cwd: ROOT, deny, allow };
  const range = arg('--range');
  const fresh = arg('--new');
  const history = arg('--history');
  const ref = arg('--ref');
  if (!argv.includes('--all') && !range && !fresh && !history && !ref) {
    console.error('usage: privacy-check.mjs [--all] [--range <a>..<b> | --new <sha> | --history <sha>] '
      + '[--ref <name> [--sha <sha>]] [--no-denylist] | --self-check');
    return 2;
  }
  const hits = [];
  if (argv.includes('--all')) hits.push(...scanTree(opts));
  if (range || fresh || history) hits.push(...scanCommits(listCommits({ range, fresh, history, cwd: ROOT }), opts));
  if (ref) hits.push(...scanRef(ref, arg('--sha'), opts));
  // CI logs are public: never echo the offending line there, and never a denylist term anywhere.
  const showLine = !process.env.CI;
  for (const h of hits) {
    const detail = h.rule === 'denylist' ? h.text : showLine ? h.src.trim().slice(0, 120) : '';
    console.error(`${h.file}:${h.line}  ${h.rule}  ${detail}`);
  }
  if (hits.length) {
    console.error(`\nprivacy-check: ${hits.length} hit(s). Fix them, or add a fixture literal to ${ALLOW_FILE}.`);
    return 1;
  }
  console.log(`privacy-check: clean${deny.length ? '' : ' (denylist skipped)'}`);
  return 0;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
