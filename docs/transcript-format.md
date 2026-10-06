# Claude Code transcript format

Verified on Claude Code 2.1.220–2.1.232, Windows 11, 2026-08-14. Everything `ingest.mjs`
depends on. Getting any of these wrong produces a silently-wrong corpus rather than an error.

## Where transcripts live

**Three roots**, all live. The "profile copies get overwritten by the launcher" rule applies
to *config*; each profile keeps its own `projects/`, so these are three separate corpora.

| root | sessions | files | size |
|---|---|---|---|
| `~/.claude/projects` | 47 | 211 | 110 MB |
| `~/.claude-work/projects` | 22 | 45 | 17 MB |
| `~/.claude-personal/projects` | 31 | 67 | 24 MB |

Retention is `cleanupPeriodDays`, default **30**: Claude Code deletes session files older
than that at startup.

```
<root>/projects/
  C--dev-glasshouse/                       # cwd, every non-[A-Za-z0-9-] char -> '-'  (LOSSY)
    <sessionId>.jsonl
    <sessionId>/subagents/agent-<agentId>.jsonl
    <sessionId>/subagents/agent-<agentId>.meta.json   # {agentType, description, toolUseId, spawnDepth}
    <sessionId>/tool-results/<toolUseId>.txt          # spilled overflow tool output
    memory/MEMORY.md                                  # not a transcript
```

- Project dir names are **not invertible**. Read the true `cwd` from inside the entries.
- **Subagent files outweigh their parents** — 164 of 211 files in the largest root; 10.4 MB
  of subagents for one 8.8 MB session. A walker that only picks up top-level `<sessionId>.jsonl`
  misses most of the corpus.
- `sessionId` is safe as a primary key (disjoint across roots). Project *slugs* collide across
  roots, and one session spans two slugs if a worktree is entered mid-session — so group by
  `sessionId`, never by directory.
- Session file sizes: median 236 KB, mean 516 KB, max 8.83 MB.

## Structure

JSONL, one object per line, appended in wall-clock order — but the conversation is a **tree**
linked by `uuid`/`parentUuid`, not a list. It branches on rewind-and-retry and on subagents.
`promptId` groups all entries of one user turn. At a compaction boundary `parentUuid` is `null`
and `logicalParentUuid` bridges the gap.

The final line may be **torn**, because the file is appended to while being read. Every parse
must be `try { JSON.parse(line) } catch { continue }`.

### Gotchas that cost real time

- **`sessionId` ≠ `session_id`** on the same entry. `sessionId` matches the filename;
  `session_id` is a per-request/agent id. Always use `sessionId`.
- **Thinking text is not on disk.** `thinking` totals 673 characters across 52 MB, while
  `signature` totals 5.4 MB of encrypted base64. Unrecoverable at any price.
- **Mojibake.** Hook, attachment and compact-summary `content` is UTF-8 bytes reinterpreted as
  **cp1252** — an em-dash arrives as `â€”`. The inverse is cp1252, *not* latin1: latin1 maps
  bytes 0x80–0x9F straight through, but cp1252 maps them to printable characters
  (0x80 → U+20AC, 0x94 → U+201D), so `Buffer.from(s, 'latin1')` silently produces garbage.
  See `repairMojibake` in `ingest.mjs`.
- **Plugin skills load from `plugins/cache/<marketplace>/<plugin>/<version>/skills/`**, not
  from `plugins/marketplaces/`. Globbing only the marketplace dirs matched 2 of 21 skills
  actually in use.

## Identifying a real human turn

There is **no single field** for this. The tempting predicate
`origin.kind === "human" && promptSource === "typed"` captures 381 turns where the true count
is 685 — it drops 44%, because `origin` and `promptSource` are absent on most entries
(24 of 1141 in one sampled session).

Shape first, then refine with the fields. A `user` entry is *not* human input when:

- `isMeta` or `isCompactSummary` is set
- `message.content` is an array whose first block is `tool_result`
- the text starts with `<task-notification`, `<scheduled-wakeup`, `<background-task`
- the text starts with `[Request interrupted`
- the text contains `<local-command-stdout|stderr|caveat>`

And it is a *different kind* of input when the text contains `<command-name>` (slash command)
or `<bash-input>` (the user ran a command themselves — the strongest possible signal that
Claude failed to do something).

**A subagent's opening prompt is human-shaped but Claude wrote it.** It is a plain `user`
entry with no distinguishing fields, sitting first in a subagent file. 223 of them exist; left
labelled `typed` they pollute the one signal a review depends on most. `ingest.mjs` labels
them `spawn` on the basis of `agentId`/`isSidechain`.

## Entry types

Counted over 200 files. Conversational: `assistant` 13561, `user` 8092, `attachment` 2421,
`system` 881.

**Skip these** — mutable session state, rewritten as things change, carrying no
`uuid`/`timestamp`/`parentUuid`: `last-prompt`, `mode`, `permission-mode`, `agent-name`,
`worktree-state`, `relocated`, `pr-link`, `custom-title`, `file-history-snapshot`,
`file-history-delta`, `queue-operation`, `fork-context-ref`. `ai-title` is read (for its
`aiTitle` field) then skipped.

### `assistant`

`message.content` blocks are exactly one level deep: `{type:"text",text}`,
`{type:"thinking",thinking,signature}`, `{type:"tool_use",id,name,input,caller}`.

Attribution fields, the cleanest usage signal available — better than parsing `Skill` tool
calls: `attributionSkill` (2329), `attributionAgent` (6613), `attributionPlugin` (1904),
`attributionMcpServer`/`attributionMcpTool` (3071). Also `effort`, `requestId`,
`isAbortedMidStream`, `isApiErrorMessage`+`apiErrorStatus`.

**Token counts need `requestId` dedupe.** One API response spans several `assistant` entries
and only the last carries the real `output_tokens`; without deduping, totals run 3–10× high.

### `user`

Tool results are `{type:"tool_result", tool_use_id, content, is_error}`. `is_error` is set on
**2809 of 7139 tool calls (39%)**. `toolUseResult` is a structured near-duplicate and the
single largest consumer of bytes in the store (20.8%).

**Correction signals are indexed fields, not something a model has to notice:**

| field | count | meaning |
|---|---|---|
| `toolDenialKind` | 35 | `automode-blocked` \| `user-rejected` \| `permission-rule` \| `automode-unavailable` |
| `userFeedback` | 8 | the reason the user typed when rejecting |
| `interruptedMessageId` | 5 | ESC mid-turn |
| `is_error: true` | 2809 | on the tool_result block |

### `system`

`subtype`: `turn_duration` 402, `stop_hook_summary` 325, `local_command` 78,
**`away_summary` 64**, `compact_boundary` 7, `informational` 2, `api_error` 2, `agents_killed` 1.

`away_summary` is a **plain-English recap of a turn, already written by the harness** — free
summaries, highest value per byte alongside compact summaries. The compact summary itself is
the *next* entry after a `compact_boundary`: a `user` entry with `isCompactSummary: true`.
`compactMetadata` gives real token counts (`preTokens`, `postTokens`, `cumulativeDroppedTokens`).

### `attachment`

26 subtypes. Hook output lives here with `hookName`, `hookEvent`, `toolUseID`, `content`.
The large ones — `skill_listing` (4.89 MB), `deferred_tools_delta` (4.85 MB),
`agent_listing_delta`, `mcp_instructions_delta`, `task_reminder` — are injected capability
rosters, identical across sessions, with **zero review value**. Eliding them saves 12.4 MB.

## Byte breakdown

52 MB across 47 sessions:

| share | content |
|---|---|
| 20.8% | `toolUseResult` (duplicate structured copy) |
| 13.0% | `tool_result` content |
| 10.4% | thinking **signatures** (encrypted) |
| 10.2% | attachments |
| 6.9% | `tool_use` inputs |
| 4.2% | user-role text that is not human |
| 1.2% | assistant prose |
| 0.09% | real typed human text (47,156 chars total) |
| 0.001% | thinking **text** |
| ~26% | JSON key overhead |

The entire semantic conversation is under 3% of the bytes.
