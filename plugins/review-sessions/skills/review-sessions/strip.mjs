#!/usr/bin/env node
// Projects a raw Claude Code transcript into reviewable rows, in memory.
//
// Claude Code logs every conversation in full, then deletes it after `cleanupPeriodDays`
// (default 30). Those logs also embed the contents of every file ever read, so they are
// unreadable as evidence and unsafe to quote. This module fixes both:
//
//   raw .jsonl  ->  stripSession()  ->  { header, rows }
//
// File contents are elided to lengths, token shapes are redacted, and the ~9x smaller
// result is what a review actually reads. Nothing is written to disk here; the caller
// decides whether a projection is worth keeping.
//
// Extracted from the retired ingest.mjs, which also archived transcripts and ran on a
// SessionStart hook. Both are gone: the review reads the live logs directly and accepts
// the retention window as its horizon.
//
// Node built-ins only, no dependencies -- that convention is what lets this ship inside a
// skill folder with no install step.
// Verify with: node strip.mjs --self-check

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import assert from 'node:assert';

export const STRIP_VERSION = 1;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Exported so `review.mjs --scan-output` can re-apply the same patterns to what actually
// landed on disk. That pass is a second opinion on redact()'s call sites, so it has to read
// this table rather than keep a copy of it.
export const SECRETS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // The excluded […] characters are this module's own elision and truncation markers.
  // Without them, `apikey: …[+514]` -- a value already cut by the input cap -- matches
  // and reports itself as a leak.
  /\b(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"'&;,)…[\]{}]{6,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  // Not a credential — third-party PII. Colleagues' work addresses accumulate in shell
  // commands and git output, and unlike the OS username and cwd paths above them, they
  // are not my identifiers to publish. Must stay LAST: the URL-creds pattern above needs
  // the `user:pass@host` shape intact to match, and this would eat the host half first.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

// Every string that survives a projection goes through here, so there is exactly one place
// to add a pattern.
//
// This single chokepoint replaced ingest.mjs's separate --scan-secrets pass over the committed
// corpus. That removal came with a stated condition: "if proposals are ever published anywhere
// but this machine, restore a verification pass over the output directory." Both halves came
// true — a private remote was added 2026-08-21, and report.mjs added a hand-typed call site —
// so the second opinion is back as `review.mjs --scan-output`, scoped to the output directory
// instead of a corpus. Run it before any push.
export function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const re of SECRETS) out = out.replace(re, '[REDACTED]');
  return out;
}

// Tool output read from one of these never keeps a text head, only its length. The
// per-pattern redaction above catches token shapes; this catches a whole credentials
// file, where every line is a secret and none of them look like one.
const SECRET_PATH = /(^|[\\/])\.env|credential|secret|id_rsa|\.pem$|\.npmrc|\.pgpass|[\\/]\.aws[\\/]/i;

// ---------------------------------------------------------------------------
// Text repair
// ---------------------------------------------------------------------------

// Hook, attachment and compact-summary text is stored as UTF-8 bytes reinterpreted as
// cp1252, so an em-dash (E2 80 94) arrives as "\u00e2\u20ac\u201d".
//
// The inverse is cp1252, NOT latin1: latin1 maps bytes 0x80-0x9F straight to U+0080-U+009F,
// but cp1252 maps them to printable characters (0x80 -> U+20AC, 0x94 -> U+201D). Using
// Buffer.from(s, 'latin1') silently truncates those to the wrong byte and produces garbage.
const CP1252_TO_BYTE = new Map(Object.entries({
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}).map(([k, v]) => [Number(k), v]));

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

// Guarded two ways: bail if any character cannot have come from a single cp1252 byte, and
// require the bytes to be valid UTF-8. Both failures return the input untouched, so text
// that was already correct is never corrupted.
export function repairMojibake(s) {
  if (typeof s !== 'string' || !/[\u00c2-\u00e3]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp <= 0xff) bytes[i] = cp;
    else if (CP1252_TO_BYTE.has(cp)) bytes[i] = CP1252_TO_BYTE.get(cp);
    else return s;
  }
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return s;
  }
}

const stripReminders = (s) =>
  typeof s === 'string' ? s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() : s;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export function* walkJsonl(dir) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

const safeDirs = (d) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

// Any `~/.claude*` directory holding a projects/ subtree is a live corpus.
//
// Discovered, never hardcoded. A user may run one Claude Code profile or several -- CLAUDE_CONFIG_DIR
// selects between ~/.claude, ~/.claude-work, ~/.claude-personal or any other ~/.claude-* -- and each
// keeps its own projects/. Building for a single profile silently drops whatever share of the corpus
// lives in the others, and a hardcoded list sends a single-profile user looking for directories that
// do not exist. Config may or may not be shared between profiles; transcripts never are.
export function discoverRoots(home = homedir()) {
  return safeDirs(home)
    .filter((name) => name === '.claude' || name.startsWith('.claude-'))
    .filter((name) => existsSync(join(home, name, 'projects')))
    .sort();
}

// Subagent transcripts are 69% of the files and hold most of the work, so a walker that
// only picks up <sessionId>.jsonl at the top level misses the majority of the corpus.
export function classifyFile(rootDir, p) {
  const parts = relative(rootDir, p).split(sep);
  const project = parts[0];
  const subIdx = parts.indexOf('subagents');
  if (subIdx !== -1) {
    const base = basename(p, '.jsonl');
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(p.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch {
      /* no sidecar */
    }
    return {
      project,
      sessionId: parts[subIdx - 1],
      kind: 'subagent',
      agentId: base.replace(/^agent-/, ''),
      meta,
    };
  }
  if (parts.includes('workflows')) {
    return { project, sessionId: parts[1], kind: 'subagent', meta: { agentType: 'workflow' } };
  }
  return { project, sessionId: basename(p, '.jsonl'), kind: 'main', meta: null };
}

// sessionId -> [{ path, rel, root, info }], across every live root.
//
// One session spans several files: the main transcript plus a sidecar per subagent, and a
// resumed session appends more. Grouping by sessionId is what makes 332 files on this
// machine resolve to 102 sessions.
export function groupLiveSessions({ home = homedir(), roots = null } = {}) {
  const sessions = new Map();
  for (const root of roots ?? discoverRoots(home)) {
    const rootDir = join(home, root, 'projects');
    if (!existsSync(rootDir)) continue;
    for (const p of walkJsonl(rootDir)) {
      const info = classifyFile(rootDir, p);
      if (!sessions.has(info.sessionId)) sessions.set(info.sessionId, []);
      sessions.get(info.sessionId).push({
        path: p,
        rel: `${root}/${relative(rootDir, p).split(sep).join('/')}`,
        root,
        info,
      });
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Classification of a user entry
// ---------------------------------------------------------------------------

// Returns a label, never a boolean. Requiring origin.kind==='human' && promptSource==='typed'
// looks precise but fails open: those fields are absent on most entries, and gating on them
// drops 44% of real typed turns (381 captured of 685 actual). So shape first, then use the
// fields only to refine the label.
export function humanKind(e) {
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary) return null;
  const c = e.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const first = c[0];
    if (!first || first.type === 'tool_result') return null;
    if (first.type === 'text') text = first.text || '';
    else if (first.type === 'image') return 'image';
  }
  if (text == null) return null;
  if (/^<(?:task-notification|scheduled-wakeup|background-task)/.test(text)) return null;
  if (text.startsWith('[Request interrupted')) return null;
  if (/<local-command-(?:stdout|stderr|caveat)>/.test(text)) return null;
  if (/<command-(?:name|message)>/.test(text)) return 'slash';
  if (/<bash-input>/.test(text)) return 'bashInput';
  const src = e.promptSource;
  if (src === 'queued') return 'queued';
  if (src === 'sdk') return 'sdk';
  if (src === 'suggestion_accepted') return 'suggestion';
  return 'typed';
}

function humanText(e) {
  const c = e.message?.content;
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? (c[0]?.text ?? '') : '';
  return redact(stripReminders(repairMojibake(raw)));
}

// ---------------------------------------------------------------------------
// The five blob doors
// ---------------------------------------------------------------------------

// Door 2. Whole-file payloads are keyed; everything else is capped. Bash/PowerShell
// commands survive nearly whole -- they are the single highest-value review signal and
// also the main leak vector, which is why redact() is applied to every survivor.
const BLOB_KEYS = new Set(['content', 'old_string', 'new_string', 'file_text', 'contents', 'edits']);
const INPUT_CAP = 500;

export function elideToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (BLOB_KEYS.has(k)) {
      out[k] = { _elided: typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length };
    } else if (typeof v === 'string') {
      out[k] = v.length > INPUT_CAP ? redact(v.slice(0, INPUT_CAP)) + `…[+${v.length - INPUT_CAP}]` : redact(v);
    } else if (v === null || typeof v !== 'object') {
      out[k] = v;
    } else {
      const j = JSON.stringify(v);
      out[k] = j.length <= 300 ? v : { _elided: j.length };
    }
  }
  return out;
}

// Door 1. Errors get a bigger head than successes: an error message IS the signal, while
// a successful Read's output is the file we are trying not to keep.
const HEAD_ERR = 400;
const HEAD_OK = 150;

export function toolResultEnvelope(block, sourcePath) {
  const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null);
  const err = block.is_error === true;
  const row = { id: block.tool_use_id, n: raw.length };
  if (err) row.err = true;
  if (sourcePath && SECRET_PATH.test(sourcePath)) return row; // length only
  const cap = err ? HEAD_ERR : HEAD_OK;
  row.head = redact(repairMojibake(raw.slice(0, cap)));
  if (raw.length > cap) row.more = raw.length - cap;
  return row;
}

// toolUseResult is a structured near-duplicate of the block above and was the single largest
// consumer of bytes in the old store (20.8%). Keep the scalars that say what happened.
const TUR_KEYS = [
  'type', 'filePath', 'numLines', 'totalLines', 'exitCode', 'interrupted',
  'returnCodeInterpretation', 'agentId', 'stdout_lines', 'stderr_lines',
];

function turScalars(tur) {
  if (!tur || typeof tur !== 'object') return undefined;
  const out = {};
  for (const k of TUR_KEYS) if (tur[k] !== undefined && typeof tur[k] !== 'object') out[k] = tur[k];
  if (tur.file && typeof tur.file === 'object') {
    if (tur.file.filePath) out.filePath = tur.file.filePath;
    if (tur.file.totalLines !== undefined) out.totalLines = tur.file.totalLines;
  }
  return Object.keys(out).length ? out : undefined;
}

// Doors 3 and 5. Door 5 is the surprise: injected capability rosters and skill bodies are
// 12.4 MB of text that is identical across sessions and has no review value at all --
// a bigger saving than any file content.
const ATTACH_ELIDE = new Set([
  'file', 'edited_text_file', 'opened_file_in_ide', 'nested_memory', 'compact_file_reference',
  'skill_listing', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta',
  'task_reminder', 'selected_lines_in_ide',
]);
const ATTACH_CAP = 800;

export function attachmentRow(a) {
  const row = { t: 'attach', sub: a.type };
  for (const k of ['hookName', 'hookEvent', 'toolUseID', 'filePath', 'command', 'exitCode']) {
    if (a[k] !== undefined) row[k === 'hookName' ? 'hook' : k === 'hookEvent' ? 'hev' : k] = a[k];
  }
  const body = typeof a.content === 'string' ? a.content : a.content ? JSON.stringify(a.content) : '';
  if (!body) return row;
  if (ATTACH_ELIDE.has(a.type)) row.body = { _elided: body.length };
  else {
    const fixed = redact(repairMojibake(body));
    row.body = fixed.length > ATTACH_CAP ? fixed.slice(0, ATTACH_CAP) + `…[+${fixed.length - ATTACH_CAP}]` : fixed;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Mutable session state -- not events, and carrying no uuid/timestamp/parentUuid
// ---------------------------------------------------------------------------
const SKIP_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'agent-name', 'worktree-state', 'relocated',
  'pr-link', 'custom-title', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'fork-context-ref',
]);

const CAUSE = /^\*{0,2}Cause:\*{0,2}\s*(.+?)\s*\**$/i;

// ---------------------------------------------------------------------------
// Project one entry to zero or more rows
// ---------------------------------------------------------------------------
export function stripEntry(e, ctx) {
  if (!e || typeof e !== 'object') return [];
  if (e.type === 'ai-title') {
    if (e.aiTitle) ctx.aiTitle = e.aiTitle;
    return [];
  }
  if (SKIP_TYPES.has(e.type)) return [];

  const base = {};
  if (e.uuid) base.u = e.uuid;
  if (e.parentUuid) base.pu = e.parentUuid;
  if (e.logicalParentUuid) base.lpu = e.logicalParentUuid;
  if (e.timestamp) base.ts = e.timestamp;
  if (e.promptId) base.pid = e.promptId;
  if (e.isSidechain) base.sc = true;
  if (ctx.agentId) base.ag = ctx.agentId;

  // Header facts worth harvesting while passing through.
  if (e.cwd) ctx.cwd = e.cwd;
  if (e.gitBranch) ctx.gitBranch = e.gitBranch;
  if (e.version) ctx.ccVersion = e.version;
  if (e.slug) ctx.slug = e.slug;
  if (e.entrypoint) ctx.entrypoint = e.entrypoint;
  if (e.timestamp) {
    if (!ctx.firstTs || e.timestamp < ctx.firstTs) ctx.firstTs = e.timestamp;
    if (!ctx.lastTs || e.timestamp > ctx.lastTs) ctx.lastTs = e.timestamp;
  }

  const rows = [];

  if (e.type === 'attachment' && e.attachment) {
    rows.push({ ...base, ...attachmentRow(e.attachment) });
    return rows;
  }

  if (e.type === 'system') {
    const row = { ...base, t: 'system', sub: e.subtype };
    if (e.level) row.level = e.level;
    if (typeof e.content === 'string') {
      const fixed = redact(repairMojibake(e.content));
      row.content = fixed.length > 1500 ? fixed.slice(0, 1500) + '…' : fixed;
      if (e.subtype === 'away_summary') ctx.counts.awaySummaries++;
    }
    if (e.durationMs !== undefined) row.durationMs = e.durationMs;
    if (e.messageCount !== undefined) row.messageCount = e.messageCount;
    if (e.compactMetadata) {
      const m = e.compactMetadata;
      row.compact = { trigger: m.trigger, pre: m.preTokens, post: m.postTokens, dropped: m.cumulativeDroppedTokens };
      ctx.counts.compactions++;
    }
    if (Array.isArray(e.hookInfos)) {
      row.hooks = e.hookInfos.map((h) => ({ cmd: h.command, ms: h.durationMs }));
    }
    rows.push(row);
    return rows;
  }

  if (e.type === 'assistant') {
    const msg = e.message || {};
    const row = { ...base, t: 'a' };
    if (msg.model) row.model = msg.model;
    if (e.effort) row.eff = e.effort;
    if (e.attributionSkill) { row.sk = e.attributionSkill; ctx.skills.add(e.attributionSkill); }
    if (e.attributionAgent) { row.agt = e.attributionAgent; ctx.agents.add(e.attributionAgent); }
    if (e.attributionPlugin) { row.pl = e.attributionPlugin; ctx.plugins.add(e.attributionPlugin); }
    if (e.attributionMcpServer) { row.mcp = e.attributionMcpServer; ctx.mcp.add(e.attributionMcpServer); }
    if (e.isAbortedMidStream) { row.abort = true; ctx.counts.aborts++; }
    if (e.isApiErrorMessage) row.apiErr = e.apiErrorStatus ?? true;

    const u = msg.usage;
    if (u && e.requestId && !ctx.seenRequests.has(e.requestId)) {
      // One API response spans several assistant entries and only the last carries the
      // real output count, so dedupe on requestId or the totals run 3-10x high.
      ctx.seenRequests.add(e.requestId);
      ctx.tokens.in += u.input_tokens || 0;
      ctx.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
      ctx.tokens.cacheRead += u.cache_read_input_tokens || 0;
      ctx.tokens.out += u.output_tokens || 0;
    }
    if (u) row.usage = [u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0];

    const parts = [];
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string') {
        const fixed = redact(repairMojibake(c.text));
        parts.push(fixed);
        ctx.counts.assistantTexts++;
        for (const line of c.text.split('\n')) {
          const m = line.replace(/^[\s>*_•-]+/, '').match(CAUSE);
          if (m) rows.push({ ...base, t: 'cause', text: redact(m[1]) });
        }
      } else if (c.type === 'thinking') {
        // Thinking text is not on disk: 673 chars across 52 MB, plus 5.4 MB of encrypted
        // signatures. The count is kept only to prove there is nothing to recover.
        parts.push({ th: (c.thinking || '').length });
      } else if (c.type === 'tool_use') {
        parts.push({ tool: c.name, id: c.id, in: elideToolInput(c.input) });
        ctx.counts.toolUses[c.name] = (ctx.counts.toolUses[c.name] || 0) + 1;
        const fp = c.input?.file_path || c.input?.notebook_path;
        if (c.id && fp) ctx.toolPaths.set(c.id, fp);
      }
    }
    if (parts.length) row.c = parts;
    rows.unshift(row);
    return rows;
  }

  if (e.type === 'user') {
    if (e.isCompactSummary) {
      const c = e.message?.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? (c[0]?.text ?? '') : '';
      return [{ ...base, t: 'compact', text: redact(repairMojibake(txt)) }];
    }

    let kind = humanKind(e);
    if (kind) {
      // A subagent transcript opens with the prompt that spawned it, stored as a plain
      // user entry with no origin fields -- indistinguishable by shape from something the
      // user typed. Left as 'typed' it pollutes the one signal the review depends on most
      // ("what does he keep asking for") with prompts Claude wrote to itself.
      if (ctx.agentId || e.isSidechain) kind = 'spawn';
      ctx.counts.human[kind] = (ctx.counts.human[kind] || 0) + 1;
      return [{ ...base, t: 'h', hk: kind, text: humanText(e) }];
    }

    // Interrupts and denials are how corrections show up as data rather than as
    // something a reviewer has to notice, so they are never truncated.
    const row = { ...base, t: 'u' };
    let keep = false;
    if (e.interruptedMessageId) { row.intr = e.interruptedMessageId; ctx.counts.interrupts++; keep = true; }
    if (e.toolDenialKind) { row.denial = e.toolDenialKind; ctx.counts.denials++; keep = true; }
    if (e.userFeedback !== undefined) {
      row.fb = redact(typeof e.userFeedback === 'string' ? e.userFeedback : JSON.stringify(e.userFeedback));
      ctx.counts.feedback++;
      keep = true;
    }

    const c = e.message?.content;
    if (Array.isArray(c)) {
      const results = [];
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        results.push(toolResultEnvelope(b, ctx.toolPaths.get(b.tool_use_id)));
        ctx.counts.toolResults++;
        if (b.is_error === true) ctx.counts.errors++;
        keep = true;
      }
      if (results.length) row.tr = results;
      const firstText = c.find((b) => b?.type === 'text');
      if (firstText && !row.tr) {
        row.text = redact(repairMojibake(String(firstText.text || '').slice(0, 600)));
        keep = true;
      }
    }
    const tur = turScalars(e.toolUseResult);
    if (tur) row.tur = tur;
    return keep ? [row] : [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Strip one session (main transcript + all its subagent sidecars)
// ---------------------------------------------------------------------------
export function stripSession(sessionId, files, readFile = (p) => readFileSync(p, 'utf8')) {
  // Main before subagents, then subagents by path: a fork replays its parent's entries
  // with identical uuids, so processing the parent first makes the dedupe attribute them
  // to the parent instead of stealing them.
  const ordered = [...files].sort((a, b) =>
    a.info.kind === b.info.kind ? a.path.localeCompare(b.path) : a.info.kind === 'main' ? -1 : 1,
  );

  const ctx = {
    aiTitle: null, cwd: null, gitBranch: null, ccVersion: null, slug: null, entrypoint: null,
    firstTs: null, lastTs: null,
    skills: new Set(), agents: new Set(), plugins: new Set(), mcp: new Set(),
    seenRequests: new Set(), toolPaths: new Map(), agentId: null,
    tokens: { in: 0, cacheCreate: 0, cacheRead: 0, out: 0 },
    counts: {
      human: {}, assistantTexts: 0, toolUses: {}, toolResults: 0, errors: 0,
      denials: 0, feedback: 0, interrupts: 0, aborts: 0, compactions: 0, awaySummaries: 0,
    },
  };

  const seenUuids = new Set();
  const rows = [];
  const roots = new Set();
  const projects = new Set();
  const fileMeta = [];
  const agentTypes = new Set();

  for (const f of ordered) {
    roots.add(f.root);
    projects.add(f.info.project);
    if (f.info.meta?.agentType) agentTypes.add(f.info.meta.agentType);
    let text;
    try {
      text = readFile(f.path);
    } catch {
      continue;
    }
    fileMeta.push({ p: f.rel, bytes: text.length, kind: f.info.kind });
    ctx.agentId = f.info.agentId ?? null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A torn final line is normal: sessions are appended to while being read.
        continue;
      }
      if (entry.uuid) {
        if (seenUuids.has(entry.uuid)) continue;
        seenUuids.add(entry.uuid);
      }
      for (const r of stripEntry(entry, ctx)) rows.push(r);
    }
  }

  rows.sort((a, b) => (a.ts && b.ts ? (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) : 0));

  const header = {
    v: STRIP_VERSION,
    sessionId,
    roots: [...roots],
    projects: [...projects],
    cwd: ctx.cwd,
    gitBranch: ctx.gitBranch,
    ccVersion: ctx.ccVersion,
    entrypoint: ctx.entrypoint,
    slug: ctx.slug,
    aiTitle: ctx.aiTitle,
    firstTs: ctx.firstTs,
    lastTs: ctx.lastTs,
    files: fileMeta,
    agentTypes: [...agentTypes],
    counts: { rows: rows.length, ...ctx.counts },
    tokens: ctx.tokens,
    skills: [...ctx.skills],
    agents: [...ctx.agents],
    plugins: [...ctx.plugins],
    mcp: [...ctx.mcp],
  };
  return { header, rows };
}

// Serialise a projection the way a stripped .jsonl looks: header first, then rows.
export const serialize = ({ header, rows }) =>
  [header, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// Self-check -- fixtures only, never the real logs
// ---------------------------------------------------------------------------
export function selfCheck() {
  // redact
  assert.equal(redact('curl -H "Authorization: Bearer sk-ant-abc123def456"').includes('sk-ant'), false);
  assert.match(redact('git remote add o https://x:ghp_aaaaaaaaaaaa@github.com/y'), /REDACTED/);
  assert.match(redact('export TOKEN=abcdef123456'), /REDACTED/, 'token= inside a command');
  assert.match(redact('psql postgres://user:pw123@host/db'), /REDACTED/);
  assert.equal(redact('ls -la /tmp'), 'ls -la /tmp', 'no false positive on a plain command');

  // humanKind -- every shape observed in the corpus
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  assert.equal(humanKind(user('why does this fail?')), 'typed');
  assert.equal(humanKind(user('typed while busy', { promptSource: 'queued' })), 'queued');
  assert.equal(humanKind(user('from sdk', { promptSource: 'sdk' })), 'sdk');
  assert.equal(humanKind(user('ok', { promptSource: 'suggestion_accepted' })), 'suggestion');
  assert.equal(humanKind(user('<command-name>/clear</command-name>')), 'slash');
  assert.equal(humanKind(user('<bash-input>claude --resume</bash-input>')), 'bashInput');
  assert.equal(humanKind(user('<local-command-stdout>out</local-command-stdout>')), null);
  assert.equal(humanKind(user('<task-notification><task-id>x</task-id>')), null);
  assert.equal(humanKind(user([{ type: 'text', text: '[Request interrupted by user]' }])), null);
  assert.equal(humanKind(user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }])), null);
  assert.equal(humanKind(user('meta', { isMeta: true })), null);
  assert.equal(humanKind(user('summary', { isCompactSummary: true })), null);
  // A turn with no origin/promptSource at all is still a real turn -- gating on those
  // fields is what dropped 44% of human input.
  assert.equal(humanKind(user('no origin fields present')), 'typed');

  // Door 2
  const wi = elideToolInput({ file_path: 'a.ts', content: 'x'.repeat(5000) });
  assert.deepEqual(wi.content, { _elided: 5000 });
  assert.equal(wi.file_path, 'a.ts');
  const ei = elideToolInput({ file_path: 'a.ts', old_string: 'a'.repeat(99), new_string: 'b'.repeat(80) });
  assert.deepEqual(ei.old_string, { _elided: 99 });
  assert.deepEqual(ei.new_string, { _elided: 80 });
  assert.equal(elideToolInput({ command: 'git status' }).command, 'git status', 'commands survive');
  assert.match(elideToolInput({ command: 'x'.repeat(900) }).command, /\[\+400\]$/);

  // Door 1
  const ok = toolResultEnvelope({ tool_use_id: 't1', content: 'y'.repeat(1000) }, 'src/a.ts');
  assert.equal(ok.n, 1000);
  assert.equal(ok.head.length, HEAD_OK);
  assert.equal(ok.err, undefined);
  const bad = toolResultEnvelope({ tool_use_id: 't2', content: 'z'.repeat(1000), is_error: true }, 'src/a.ts');
  assert.equal(bad.err, true);
  assert.equal(bad.head.length, HEAD_ERR, 'errors get the bigger head');
  const env = toolResultEnvelope({ tool_use_id: 't3', content: 'API_KEY=hunter2hunter2' }, 'C:\\app\\.env');
  assert.equal(env.head, undefined, 'a .env read keeps no text at all');
  assert.equal(env.n, 22);

  // Doors 3 and 5
  assert.deepEqual(attachmentRow({ type: 'skill_listing', content: 'x'.repeat(9000) }).body, { _elided: 9000 });
  assert.deepEqual(attachmentRow({ type: 'file', content: 'x'.repeat(50) }).body, { _elided: 50 });
  const hookRow = attachmentRow({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'PONYTAIL ACTIVE' });
  assert.equal(hookRow.body, 'PONYTAIL ACTIVE', 'hook output is kept');
  assert.equal(hookRow.hook, 'SessionStart:startup');

  // Mojibake, both directions
  assert.equal(repairMojibake('level \u00e2\u20ac\u201d full'), 'level — full');
  assert.equal(repairMojibake('already — fine'), 'already — fine', 'must be a no-op on valid UTF-8');
  assert.equal(repairMojibake('plain ascii'), 'plain ascii');

  // Root discovery is by probe, not by a hardcoded list. A colleague has one profile; this
  // machine has three. Neither number may be baked in.
  assert.deepEqual(discoverRoots('/nonexistent-home-xyz'), [], 'a home with no profiles yields none');

  // Full projection over a two-file fixture: dedupe, ordering, causes, determinism.
  const main = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00Z', cwd: 'C:\\dev\\x', gitBranch: 'main', version: '2.1.221', message: { role: 'user', content: 'please fix the parser' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-08-01T10:00:05Z', requestId: 'req1', attributionSkill: 'ponytail:ponytail', message: { role: 'assistant', model: 'claude-opus-5', usage: { output_tokens: 10 }, content: [{ type: 'thinking', thinking: '', signature: 'BIGBASE64' }, { type: 'text', text: 'Fixed.\n**Cause:** I assumed the column was user_id.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\app\\.env' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-08-01T10:00:06Z', toolUseResult: { type: 'text', file: { filePath: 'C:\\app\\.env', totalLines: 3 } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'SECRET_KEY=abcdef1234567890' }] } }),
    JSON.stringify({ type: 'mode', sessionId: 's1', mode: 'plan' }),
    'not json at all',
  ].join('\n');
  const sub = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00Z', message: { role: 'user', content: 'please fix the parser' } }),
    // A subagent's opening prompt: human-shaped, but written by Claude, not the user.
    JSON.stringify({ type: 'user', uuid: 'u9', timestamp: '2026-08-01T10:00:08Z', message: { role: 'user', content: 'Explore the repo and report the layout.' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', isSidechain: true, timestamp: '2026-08-01T10:00:10Z', requestId: 'req2', message: { role: 'assistant', content: [{ type: 'text', text: 'sub done' }] } }),
  ].join('\n');

  const files = [
    { path: 'M', rel: '.claude/p/s1.jsonl', root: '.claude', info: { project: 'p', sessionId: 's1', kind: 'main', meta: null } },
    { path: 'S', rel: '.claude/p/s1/subagents/agent-a9.jsonl', root: '.claude', info: { project: 'p', sessionId: 's1', kind: 'subagent', agentId: 'a9', meta: { agentType: 'Explore' } } },
  ];
  const read = (p) => (p === 'M' ? main : sub);
  const { header, rows } = stripSession('s1', files, read);

  assert.equal(header.cwd, 'C:\\dev\\x');
  assert.equal(header.gitBranch, 'main');
  assert.deepEqual(header.skills, ['ponytail:ponytail']);
  assert.deepEqual(header.agentTypes, ['Explore']);
  assert.equal(header.counts.human.typed, 1, 'the replayed duplicate turn is deduped away');
  assert.equal(header.counts.human.spawn, 1, "a subagent's opening prompt is not user input");
  assert.equal(rows.find((r) => r.hk === 'spawn').text, 'Explore the repo and report the layout.');
  assert.equal(header.tokens.out, 10);
  assert.equal(rows.filter((r) => r.t === 'cause').length, 1);
  assert.equal(rows.find((r) => r.t === 'cause').text, 'I assumed the column was user_id.');
  assert.equal(rows.filter((r) => r.t === 'a' && r.sc).length, 1, 'subagent row present');
  assert.equal(rows.some((r) => r.t === 'system' || r.t === 'mode'), false, 'state records skipped');

  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes('SECRET_KEY'), false, 'the .env read left no content behind');
  assert.equal(serialized.includes('BIGBASE64'), false, 'thinking signatures are dropped');
  const thinking = rows.find((r) => r.t === 'a')?.c?.find((x) => x && x.th !== undefined);
  assert.deepEqual(thinking, { th: 0 }, 'thinking is recorded as a length only');
  const tu = rows.find((r) => r.t === 'a')?.c?.find((x) => x && x.tool);
  assert.equal(tu.tool, 'Read');
  assert.equal(rows.find((r) => r.tur)?.tur.totalLines, 3);

  // Determinism: same input twice must serialize identically, or every re-run is a diff.
  assert.equal(JSON.stringify(stripSession('s1', files, read)), JSON.stringify({ header, rows }));

  // The serialised form must round-trip: header first and recognisable as the header, which
  // is how review.mjs tells a header row from a content row.
  const first = JSON.parse(serialize({ header, rows }).split('\n')[0]);
  assert.equal(first.v, STRIP_VERSION);
  assert.equal(first.sessionId, 's1');
}

// Guarded on being the entry point, not on argv alone: review.mjs imports this module and
// runs its own --self-check, which would otherwise trip this block on import as well.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    console.log('ok');
  }
}
