---
name: project-to-markdown
description: Use when the user wants a project folder mirrored into a Markdown-only context folder for an LLM to read, when they want that folder refreshed, or when they ask what has changed since they last looked. Converts Office/PDF documents via MarkItDown, copies plain-text files verbatim, and reports what changed since THIS person's last run — which is not the same as what this run did, when colleagues share the folder. Triggers on "convert this folder to markdown", "project to markdown", "crawl the project", "update the context folder", "refresh the markdown copy", "what changed since the last crawl", "what have I missed", "what's new since I last looked".
---

# project-to-markdown

Mirrors a project folder into Markdown so an LLM can read it. First run converts
everything; later runs touch only what changed and report it.

The script does the mechanical work. Your job is step 2 (agreeing the paths) and
step 4 (saying what actually changed, in words).

## 1. Check the dependency

```
python -c "import markitdown"
```

If that fails: `pip install "markitdown[all]"`. Required on Cowork and Claude Desktop,
usually already present in a dev environment.

## 2. Settle source and output — before running anything

**Source** defaults to the current directory. If the user means a different folder
(a client folder, a OneDrive project), ask for it and pass `--source`.

**Output** defaults to:

| Source is | Output |
| --- | --- |
| a git repo | `<source>/local/project-to-markdown` |
| a plain folder | `<source>/project-to-markdown` |

Override with `--out`. State the resolved output path to the user before running,
together with this: **the script owns that folder and deletes anything in it that the
run did not produce.** Use a fresh folder, never a folder that holds anything else.
The script refuses to prune a non-empty folder with no `00-MANIFEST.json` in it.

**If the source is a git repo**, read its `.gitignore` and check for a rule covering
`local/`. If there isn't one, tell the user the output will otherwise be committed —
it can contain client material — and offer to add `local/`. Do not edit `.gitignore`
without their say-so.

## 3. Run it

```
python <this skill's folder>/project_to_markdown.py --source <path> [--out <path>]
```

Other flags:

- `--exclude NAME` — extra directory name to skip, anywhere in the tree. Repeatable.
  Use it for archive folders, superseded material, and anything no longer relevant.
  `.git`, `node_modules`, `venv`, `dist`, `build`, `__pycache__` and friends are
  already excluded.
- `--max-mb N` — size cap (default 5) for bulk data (`.csv .tsv .xlsx .xls .txt`).
  Documents are never size-gated: a 70 MB deck converts to a few KB of text, a 1 GB
  CSV is unreadable as context. Every withheld file is named in the output.
- `--force` — reconvert everything, ignoring the previous run.
- `--no-prune` — leave files the run did not produce in place.
- `--as NAME` — who is running, recorded in the shared run history. Defaults to the OS
  username. Pass it when several people share one output folder and the OS usernames
  aren't distinct.

A bare re-run needs no flags: the manifest under `--out` remembers its source.

## 4. Report what changed — for *this* person

**Read the script's `Since your last run (...)` line first.** In a shared folder it is
the answer, and it is usually not the same as what this run did: if a colleague already
crawled, this run correctly finds nothing to do while plenty has changed since the user
last looked. Never report "no changes" off the back of `Changes: added 0 | modified 0`
without checking that line.

The three cases:

| Script says | What to do |
| --- | --- |
| `Since your last run (...): N file(s) changed` | This is the user's answer. Summarise those files (below). |
| `Since your last run (...): nothing has changed.` | They are up to date. Say so and stop. |
| `First run for <who> against this folder` | No personal history to diff. Point at `00-INDEX.md` for the whole folder, and summarise the most recent `00-CHANGES.md` block for "what happened recently". |

To summarise: the script names the runs to read up on (`Written up in 00-CHANGES.md
under: ...`). Open `<output>/00-CHANGES.md`, find those blocks by their `## <timestamp>
— <who>` heading, and:

- Where a block's `### What changed` section already has prose, **use it** — a colleague's
  Claude wrote it. Don't redo the work.
- Where it still reads `_(not yet summarised)_` — read the added/modified files it lists
  (their converted `.md` output, not the binary source), work out what actually changed,
  and **replace that placeholder** with a few plain-language bullets: what the change
  was, not just which file moved. That fills the gap for the next colleague too.

Then tell the user the same thing. Deleted sources have had their output removed
already; name them, since there is nothing left to read.

## Output folder contents

| File | What it is |
| --- | --- |
| `00-INDEX.md` | folder tree + per-file manifest table |
| `00-MANIFEST.json` | machine state: per-file size/mtime/sha256, and the last 20 runs — who ran each, when, and what moved |
| `00-CHANGES.md` | per-run change log, newest first, each block headed `<timestamp> — <who>` |

Mirrored files sit beside them: converted documents as `<original name>.md`
(`charter.docx` → `charter.docx.md`), plain-text files at their exact relative path.

## Several people sharing one output folder

This is the normal case for a client folder, and it works without coordination — the
run history in `00-MANIFEST.json` is the shared state, and everyone's "since your last
run" window is computed from it.

Two things to watch:

- **Keep `--exclude` consistent across the team.** If one person excludes `archive` and
  another doesn't, each run prunes what the other produced and the folder thrashes. The
  script prints a `Note:` when this run's exclusions differ from the last one's — pass
  that on to the user rather than ignoring it.
- **Simultaneous runs are safe but wasteful.** Writes are atomic per file and both runs
  produce the same result, so nothing corrupts; the loser just did the work twice. There
  is no lock. If two people are about to run, one is enough.

## Notes

- Images, archives and other binaries are skipped, not OCR'd. Deliberate.
- Only the output folder is written to; the source is read-only.
- The intended workflow is to connect *only* the output folder to Claude or Cowork.
