"""
Mirrors a project folder into a Markdown-only context folder for LLM consumption.

Converts document formats (pptx, docx, xlsx, pdf, ...) to Markdown via MarkItDown,
copies already-plain-text files byte-for-byte, mirrors the source folder structure
inside a dedicated output folder, and writes three generated files at the output root:

    00-INDEX.md      folder tree + manifest table (human/LLM facing)
    00-MANIFEST.json machine-readable state: per-file size/mtime/hash + run dates
    00-CHANGES.md    what changed on each run, newest first

The first run converts everything. Every later run compares against the manifest and
touches only what actually changed, then reports added/modified/deleted files.

The output folder is OWNED by this script: anything inside it that the current run did
not produce is deleted, so the folder is always a true mirror of the source. Pass
--no-prune to disable that. The output folder is excluded from the crawl itself, so
re-running never reprocesses its own output.

Requires: pip install "markitdown[all]"

Usage:
    python project_to_markdown.py [--source PATH] [--out PATH] [--exclude NAME] ...
"""

import argparse
import getpass
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# --- Static defaults --------------------------------------------------------

# Directory names to never descend into, anywhere in the tree.
DEFAULT_EXCLUDED_DIRECTORY_NAMES = {
    ".git", ".svn", ".hg",
    "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
    "venv", ".venv", "env",
    "dist", "build", ".next", ".cache",
    ".idea", ".vscode",
}

# Extensions MarkItDown will actually convert (binary/office document formats).
CONVERTIBLE_EXTENSIONS = {
    ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".pdf",
}

# Extensions that are already plain text — copy verbatim, no conversion needed.
PLAIN_TEXT_EXTENSIONS = {
    ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml",
    ".yml", ".csv", ".html", ".css", ".sql", ".sh", ".toml", ".ini", ".cfg",
}

# Bulk-data formats where file size correlates directly with uselessness as LLM
# context: a 1 GB CSV can't be read into context and isn't worth syncing, while a
# 70 MB pptx converts down to a few KB of text. So the size gate applies to these
# extensions only, NOT to documents — checked before extension routing, so it
# catches both the convertible (.xlsx) and copy-verbatim (.csv) paths.
SIZE_GATED_EXTENSIONS = {".csv", ".tsv", ".xlsx", ".xls", ".txt"}
DEFAULT_MAX_GATED_FILE_BYTES = 5_000_000

INDEX_FILE_NAME = "00-INDEX.md"
MANIFEST_FILE_NAME = "00-MANIFEST.json"
CHANGES_FILE_NAME = "00-CHANGES.md"
# The three files this script generates itself. Never crawler *output*, so prune
# must leave them alone or it would delete the manifest it just wrote.
GENERATED_FILE_NAMES = {INDEX_FILE_NAME, MANIFEST_FILE_NAME, CHANGES_FILE_NAME}

OUTPUT_FOLDER_NAME = "project-to-markdown"
MANIFEST_SCHEMA_VERSION = 1
MAX_RECORDED_RUNS = 20


def long_path(path: Path) -> Path:
    """Returns a path usable past Windows' 260-char MAX_PATH limit.

    Windows refuses paths over 260 chars unless they carry the \\\\?\\ prefix, and
    LongPathsEnabled is 0 on most machines. This matters in practice, not in theory:
    mirroring a deep source tree into a nested output folder adds prefix length to
    every path, so real output paths here reach 354 chars. Without this, the bulk of
    a run fails with WinError 3 (and .stat() failing was silently bypassing the size
    gate). No-op off Windows and on already-prefixed paths; resolve() is required
    because the prefix demands a fully-qualified path with no . or .. segments.
    """
    if os.name != "nt":
        return path
    resolved_path = str(path.resolve())
    if resolved_path.startswith("\\\\?\\"):
        return path
    if resolved_path.startswith("\\\\"):
        return Path("\\\\?\\UNC" + resolved_path[1:])  # \\server\share -> \\?\UNC\server\share
    return Path("\\\\?\\" + resolved_path)


def write_bytes_atomically(target_path: Path, payload: bytes) -> None:
    """Writes via a temp sibling then os.replace, so a killed run leaves no half-file.

    A plain write truncates before writing, so an interrupted run leaves a truncated
    file that is indistinguishable from a good one — plausible size, valid UTF-8, no
    marker. Under incremental runs that corruption becomes PERMANENT: the manifest
    records the file as done against a matching source hash, so it is never rewritten.
    os.replace is atomic on both Windows and POSIX.
    """
    temporary_path = target_path.with_name(target_path.name + ".partial")
    long_path(temporary_path).write_bytes(payload)
    os.replace(long_path(temporary_path), long_path(target_path))


def write_text_atomically(target_path: Path, text: str) -> None:
    write_bytes_atomically(target_path, text.encode("utf-8"))


def hash_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def hash_file(path: Path) -> str:
    """Streams the file through sha256 — sources can be multi-GB, don't slurp."""
    digest = hashlib.sha256()
    with open(long_path(path), "rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest_entry(relative_source_path, action, output_relative_path=None,
                         error_message=None, change="added", size=None, mtime=None,
                         sha256=None):
    """Returns a single manifest record describing what happened to one source file.

    `action` says what the crawler did with the file, `change` says how it differs
    from the previous run. They are independent: an unchanged file keeps the action
    it was given last time (`converted`) alongside `change="unchanged"`, so the
    summary counts stay honest about what the output folder contains.
    """
    # Paths are stored posix-style so the manifest, the index table and the change log
    # all read the same on Windows and POSIX, and manifest keys stay portable.
    return {
        "relative_source_path": Path(relative_source_path).as_posix(),
        "action": action,  # "converted" | "copied" | "skipped" | "skipped-too-large" | "failed"
        "output_relative_path": Path(output_relative_path).as_posix() if output_relative_path else "",
        "error_message": error_message or "",
        "change": change,  # "added" | "modified" | "unchanged"
        "size": size,
        "mtime": mtime,
        "sha256": sha256,
    }


def crawl_and_convert(source_project_root: Path, output_root: Path, excluded_directory_names=None,
                      max_gated_file_bytes=DEFAULT_MAX_GATED_FILE_BYTES,
                      previous_files=None, force=False):
    """Walks source_project_root, converting/copying files into output_root.

    excluded_directory_names defaults to DEFAULT_EXCLUDED_DIRECTORY_NAMES if not given.
    max_gated_file_bytes caps the size of SIZE_GATED_EXTENSIONS files; anything
    larger is recorded as "skipped-too-large" and never read or written.
    previous_files is the previous run's manifest "files" mapping; files whose source
    is unchanged since then are skipped entirely. force ignores it and reprocesses all.
    Never deletes anything — pruning is prune_output()'s job.
    Returns (manifest_entries, directory_tree_lines).
    """
    if excluded_directory_names is None:
        excluded_directory_names = DEFAULT_EXCLUDED_DIRECTORY_NAMES
    if previous_files is None:
        previous_files = {}

    # Created on the first convertible file. A plain-text-only folder, and --self-check, then run
    # without MarkItDown installed; a missing install is recorded per file as "failed".
    markitdown_converter = None
    manifest_entries = []
    directory_tree_lines = []

    output_root_resolved = output_root.resolve()

    for current_directory, subdirectory_names, file_names in os.walk(source_project_root):
        current_directory_path = Path(current_directory)

        # Prune excluded directories in place so os.walk does not descend into them.
        # A directory holding a 00-MANIFEST.json is some run's output folder — this
        # run's, or a stale one left by a colleague whose paths were mapped differently.
        # Either way it is generated content, and crawling it feeds the tool its own
        # output (manifest and change log included).
        subdirectory_names[:] = [
            name for name in subdirectory_names
            if name not in excluded_directory_names
            and (current_directory_path / name).resolve() != output_root_resolved
            and not long_path((current_directory_path / name) / MANIFEST_FILE_NAME).exists()
        ]

        relative_directory = current_directory_path.relative_to(source_project_root)
        indent_level = len(relative_directory.parts)
        if str(relative_directory) != ".":
            directory_tree_lines.append("  " * indent_level + f"{current_directory_path.name}/")

        for file_name in sorted(file_names):
            source_file_path = current_directory_path / file_name
            relative_source_path = source_file_path.relative_to(source_project_root)
            file_extension = source_file_path.suffix.lower()
            previous_entry = None if force else previous_files.get(relative_source_path.as_posix())

            is_convertible = file_extension in CONVERTIBLE_EXTENSIONS
            is_plain_text = file_extension in PLAIN_TEXT_EXTENSIONS

            if not is_convertible and not is_plain_text:
                # Binaries, images, archives. Nothing is produced, so there is nothing
                # to detect a change in — presence in the previous manifest is enough.
                manifest_entries.append(build_manifest_entry(
                    relative_source_path, "skipped",
                    change="unchanged" if previous_entry else "added",
                ))
                # Omitted from the tree to keep it readable.
                continue

            try:
                source_stat = long_path(source_file_path).stat()
                file_size_bytes, file_mtime = source_stat.st_size, source_stat.st_mtime
            except OSError as stat_error:
                if file_extension in SIZE_GATED_EXTENSIONS:
                    # Fail CLOSED. An unmeasurable file must not be assumed small:
                    # treating it as 0 bytes would walk a multi-GB CSV straight past
                    # the gate and copy it. Refuse to process what we can't measure.
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, "failed",
                        error_message=f"could not determine file size, not processed: {stat_error}",
                        change="modified" if previous_entry else "added",
                    ))
                    directory_tree_lines.append("  " * (indent_level + 1) + f"{file_name}  [SIZE UNKNOWN]")
                    continue
                # Ungated file: no gate to bypass, so let the convert/copy branch below
                # try and record its own failure.
                file_size_bytes = file_mtime = None

            if file_extension in SIZE_GATED_EXTENSIONS and file_size_bytes > max_gated_file_bytes:
                manifest_entries.append(build_manifest_entry(
                    relative_source_path, "skipped-too-large",
                    error_message=f"{file_size_bytes / 1_000_000:.1f} MB exceeds {max_gated_file_bytes / 1_000_000:.1f} MB limit",
                    change="modified" if previous_entry else "added",
                    size=file_size_bytes, mtime=file_mtime,
                ))
                directory_tree_lines.append(
                    "  " * (indent_level + 1) + f"{file_name}  [SKIPPED: {file_size_bytes / 1_000_000:.0f} MB]"
                )
                continue

            output_relative_path = (relative_source_path.parent / f"{file_name}.md") if is_convertible else relative_source_path
            output_file_path = output_root / output_relative_path
            tree_line = ("  " * (indent_level + 1) +
                         (f"{file_name}  ->  {output_relative_path.name}" if is_convertible else file_name))

            source_sha256 = None
            if previous_entry and long_path(output_file_path).exists():
                if previous_entry.get("size") == file_size_bytes and previous_entry.get("mtime") == file_mtime:
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, previous_entry.get("action", "converted"),
                        output_relative_path, change="unchanged",
                        size=file_size_bytes, mtime=file_mtime, sha256=previous_entry.get("sha256"),
                    ))
                    directory_tree_lines.append(tree_line)
                    continue
                # mtime or size moved. Confirm with a hash before calling it modified:
                # OneDrive re-sync rewrites mtime without touching content, and without
                # this check every file reports as modified on every run and the change
                # report becomes noise.
                try:
                    source_sha256 = hash_file(source_file_path)
                except OSError:
                    source_sha256 = None
                if source_sha256 is not None and source_sha256 == previous_entry.get("sha256"):
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, previous_entry.get("action", "converted"),
                        output_relative_path, change="unchanged",
                        size=file_size_bytes, mtime=file_mtime, sha256=source_sha256,
                    ))
                    directory_tree_lines.append(tree_line)
                    continue

            change = "modified" if previous_entry else "added"

            if is_convertible:
                try:
                    if markitdown_converter is None:
                        from markitdown import MarkItDown
                        markitdown_converter = MarkItDown()
                    conversion_result = markitdown_converter.convert(str(long_path(source_file_path)))
                    long_path(output_file_path.parent).mkdir(parents=True, exist_ok=True)
                    write_text_atomically(output_file_path, conversion_result.text_content)
                    if source_sha256 is None:
                        source_sha256 = hash_file(source_file_path)
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, "converted", output_relative_path, change=change,
                        size=file_size_bytes, mtime=file_mtime, sha256=source_sha256))
                    directory_tree_lines.append(tree_line)
                except Exception as conversion_error:
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, "failed", error_message=str(conversion_error), change=change))
                    directory_tree_lines.append("  " * (indent_level + 1) + f"{file_name}  [CONVERSION FAILED]")
            else:
                try:
                    source_bytes = long_path(source_file_path).read_bytes()
                    long_path(output_file_path.parent).mkdir(parents=True, exist_ok=True)
                    write_bytes_atomically(output_file_path, source_bytes)
                    # Bytes are already in hand — hash them rather than re-reading.
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, "copied", output_relative_path, change=change,
                        size=file_size_bytes, mtime=file_mtime, sha256=hash_bytes(source_bytes)))
                    directory_tree_lines.append(tree_line)
                except Exception as copy_error:
                    manifest_entries.append(build_manifest_entry(
                        relative_source_path, "failed", error_message=str(copy_error), change=change))
                    directory_tree_lines.append("  " * (indent_level + 1) + f"{file_name}  [COPY FAILED]")

    return manifest_entries, directory_tree_lines


def prune_output(output_root: Path, produced_relative_paths):
    """Deletes everything under output_root that this run did not produce.

    A set difference, not a manifest diff — that also clears files no manifest ever
    knew about (hand-placed decks, output from an older layout), which is the point:
    the folder is a mirror, and anything else in it is stale by definition.
    Returns the removed paths, sorted.
    """
    kept_relative_paths = {Path(path).as_posix() for path in produced_relative_paths} | GENERATED_FILE_NAMES
    removed_relative_paths = []

    for current_directory, _subdirectory_names, file_names in os.walk(output_root):
        for file_name in file_names:
            file_path = Path(current_directory) / file_name
            relative_path = file_path.relative_to(output_root).as_posix()
            if relative_path in kept_relative_paths:
                continue
            long_path(file_path).unlink()
            removed_relative_paths.append(relative_path)

    # Deepest first, so a directory emptied by the loop above is itself removable.
    # Reverse string sort puts "a/b/c" ahead of "a/b"; iterdir re-checks emptiness
    # because os.walk's listing predates the deletions.
    for current_directory, _subdirectory_names, _file_names in sorted(os.walk(output_root), reverse=True):
        directory_path = Path(current_directory)
        if directory_path == output_root:
            continue
        if not any(long_path(directory_path).iterdir()):
            long_path(directory_path).rmdir()

    return sorted(removed_relative_paths)


def default_output_root(source_root: Path) -> Path:
    """Git repos get local/project-to-markdown; plain folders get project-to-markdown.

    The extra `local/` level in a repo exists so there is one obvious directory to
    gitignore. `.git` is a file, not a directory, inside a worktree — exists() covers both.
    """
    if (source_root / ".git").exists():
        return source_root / "local" / OUTPUT_FOLDER_NAME
    return source_root / OUTPUT_FOLDER_NAME


def empty_manifest():
    return {
        "schema": MANIFEST_SCHEMA_VERSION,
        "source_root": "",
        "excluded_directory_names": [],
        "max_gated_file_bytes": DEFAULT_MAX_GATED_FILE_BYTES,
        "runs": [],
        "files": {},
    }


def normalize_run_records(runs):
    """Coerces the run history to records. Early versions stored bare timestamps.

    Migrating beats bumping the schema: an unrecognised schema discards the whole
    manifest, which on a real project means re-reading ~1 GB out of OneDrive to
    rebuild output that was already correct.
    """
    normalized_runs = []
    for record in runs:
        if isinstance(record, str):
            record = {"at": record, "by": "unknown"}
        normalized_runs.append({
            "at": record.get("at", ""),
            "by": record.get("by", "unknown"),
            "added": list(record.get("added", [])),
            "modified": list(record.get("modified", [])),
            "deleted": list(record.get("deleted", [])),
        })
    return normalized_runs


def load_manifest(output_root: Path):
    """Reads 00-MANIFEST.json, or an empty skeleton. The empty case IS the first run."""
    try:
        manifest = json.loads(long_path(output_root / MANIFEST_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty_manifest()
    if manifest.get("schema") != MANIFEST_SCHEMA_VERSION:
        return empty_manifest()  # Unknown layout: redo the crawl rather than trust it.
    manifest["runs"] = normalize_run_records(manifest.get("runs", []))
    return manifest


def changes_since_last_run_by(run_records, who):
    """What this person has not seen yet, from the shared run history.

    The point of the whole multi-person story: when a colleague has already crawled,
    THIS run legitimately finds nothing to do, so "what changed" cannot come from the
    current crawl — it has to come from the runs that happened since the last one this
    person did. run_records is newest-first, including the current run at index 0.

    Returns (last_run_by_them, unseen_runs, netted_changes). netted_changes maps a
    source path to its final state across the unseen runs, so a file added and later
    deleted reads as deleted rather than as two contradictory lines.

    With no run by this person in the history there is no bookmark, so there is no
    diff to give — returns empty rather than replaying the initial crawl and calling
    the entire project "added", which is noise dressed up as news. That covers both a
    genuinely new colleague and one whose last run has aged off MAX_RECORDED_RUNS;
    the two are indistinguishable here and want the same answer.
    """
    unseen_runs = []
    last_run_by_them = None
    for record in run_records[1:]:  # index 0 is the run that just finished.
        if record["by"] == who:
            last_run_by_them = record
            break
        unseen_runs.append(record)

    if last_run_by_them is None:
        return None, [], {}

    unseen_runs.insert(0, run_records[0])

    netted_changes = {}
    for record in reversed(unseen_runs):  # oldest first, so later states win.
        for change_key in ("added", "modified", "deleted"):
            for path in record[change_key]:
                netted_changes[path] = change_key

    return last_run_by_them, unseen_runs, netted_changes


def build_run_record(run_timestamp, who, manifest_entries, deleted_relative_paths):
    """One entry in the shared run history: who ran it, when, and what moved.

    The change lists live here, not only in 00-CHANGES.md, so a colleague arriving
    later can be told what they missed without anyone parsing prose.
    """
    return {
        "at": run_timestamp,
        "by": who,
        "added": [e["relative_source_path"] for e in manifest_entries if e["change"] == "added"],
        "modified": [e["relative_source_path"] for e in manifest_entries if e["change"] == "modified"],
        "deleted": list(deleted_relative_paths),
    }


def write_manifest(output_root: Path, source_root: Path, excluded_directory_names,
                   max_gated_file_bytes, previous_runs, run_record, manifest_entries):
    manifest = {
        "schema": MANIFEST_SCHEMA_VERSION,
        "source_root": str(source_root),
        "excluded_directory_names": sorted(excluded_directory_names),
        "max_gated_file_bytes": max_gated_file_bytes,
        "runs": ([run_record] + list(previous_runs))[:MAX_RECORDED_RUNS],
        "files": {
            Path(entry["relative_source_path"]).as_posix(): {
                "action": entry["action"],
                "output_relative_path": (Path(entry["output_relative_path"]).as_posix()
                                         if entry["output_relative_path"] else ""),
                "size": entry["size"],
                "mtime": entry["mtime"],
                "sha256": entry["sha256"],
            }
            for entry in manifest_entries
        },
    }
    manifest_path = output_root / MANIFEST_FILE_NAME
    write_text_atomically(manifest_path, json.dumps(manifest, indent=2))
    return manifest_path


def write_index_file(output_root: Path, source_project_root: Path, manifest_entries,
                     directory_tree_lines, deleted_relative_paths=()):
    """Writes 00-INDEX.md: folder tree + manifest table, into output_root."""
    index_lines = []
    index_lines.append("# Project Context Index")
    index_lines.append("")
    index_lines.append(f"Source project: `{source_project_root}`")
    index_lines.append(f"Generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    index_lines.append("")

    index_lines.append("## Folder Structure")
    index_lines.append("")
    index_lines.append("```")
    index_lines.append(f"{source_project_root.name}/")
    index_lines.extend(directory_tree_lines)
    index_lines.append("```")
    index_lines.append("")

    action_counts = Counter(entry["action"] for entry in manifest_entries)
    change_counts = Counter(entry["change"] for entry in manifest_entries)

    index_lines.append("## Summary")
    index_lines.append("")
    index_lines.append(f"- Converted: {action_counts['converted']}")
    index_lines.append(f"- Copied as-is: {action_counts['copied']}")
    index_lines.append(f"- Skipped (unsupported type): {action_counts['skipped']}")
    index_lines.append(f"- Skipped (over size limit): {action_counts['skipped-too-large']}")
    index_lines.append(f"- Failed: {action_counts['failed']}")
    index_lines.append("")
    index_lines.append(
        f"This run — added: {change_counts['added']} | modified: {change_counts['modified']} | "
        f"unchanged: {change_counts['unchanged']} | deleted: {len(deleted_relative_paths)}"
    )
    index_lines.append("")

    index_lines.append("## Manifest")
    index_lines.append("")
    index_lines.append("| Source Path | Action | Change | Output Path | Error |")
    index_lines.append("| --- | --- | --- | --- | --- |")
    for entry in manifest_entries:
        index_lines.append(
            f"| {entry['relative_source_path']} | {entry['action']} | {entry['change']} | "
            f"{entry['output_relative_path']} | {entry['error_message']} |"
        )

    index_file_path = output_root / INDEX_FILE_NAME
    write_text_atomically(index_file_path, "\n".join(index_lines))
    return index_file_path


def write_changes_file(output_root: Path, run_timestamp, who, manifest_entries,
                       deleted_relative_paths, is_first_run):
    """Prepends this run's block to 00-CHANGES.md, newest run first.

    The mechanical lists are written here; the "### What changed" section is left as a
    placeholder for Claude to fill in from the actual content of the changed files.
    The heading carries who ran it, because in a shared folder the reader is often not
    the person whose run produced the block.
    """
    changes_path = output_root / CHANGES_FILE_NAME
    header = "# Change Log"
    try:
        existing_body = long_path(changes_path).read_text(encoding="utf-8").split(header, 1)[1].lstrip("\n")
    except (OSError, IndexError):
        existing_body = ""

    action_counts = Counter(entry["action"] for entry in manifest_entries)
    block = [f"## {run_timestamp} — {who}", ""]

    if is_first_run:
        block.append(
            f"Initial crawl: {action_counts['converted']} converted, {action_counts['copied']} copied, "
            f"{action_counts['skipped'] + action_counts['skipped-too-large']} skipped, "
            f"{action_counts['failed']} failed."
        )
    else:
        changed_paths_by_label = [
            (label, [e["relative_source_path"] for e in manifest_entries if e["change"] == key])
            for label, key in (("Added", "added"), ("Modified", "modified"))
        ] + [("Deleted", list(deleted_relative_paths))]

        if not any(paths for _label, paths in changed_paths_by_label):
            # No placeholder when nothing moved — it would send the reader looking for
            # a change that doesn't exist.
            block.append(f"No changes. {len(manifest_entries)} files unchanged.")
        else:
            for change_label, paths in changed_paths_by_label:
                block.append(f"- {change_label} ({len(paths)}): " + (", ".join(paths) if paths else "none"))
            block.append(f"- Unchanged: {sum(1 for e in manifest_entries if e['change'] == 'unchanged')}")
            block.append("")
            block.append("### What changed")
            block.append("")
            block.append("_(not yet summarised)_")

    block.append("")
    write_text_atomically(changes_path, "\n".join([header, ""] + block + [existing_body]).rstrip() + "\n")
    return changes_path


def check_output_root_is_safe(source_root: Path, output_root: Path, force: bool):
    """Refuses to prune a folder that isn't ours. Returns an error string, or None.

    prune_output deletes unconditionally inside output_root, so the two ways that can
    go badly wrong are both blocked before anything runs.
    """
    if output_root == source_root or output_root in source_root.parents:
        return (f"--out ({output_root}) is the source folder or contains it. "
                f"Pruning would delete the source. Pick a folder inside or beside the source.")
    if (output_root.exists() and not (output_root / MANIFEST_FILE_NAME).exists()
            and any(output_root.iterdir()) and not force):
        return (f"{output_root} is not empty and has no {MANIFEST_FILE_NAME}, so it was not "
                f"produced by this tool. Refusing to prune it. Use an empty folder, or --force.")
    return None


def run(source_root: Path, output_root: Path, excluded_directory_names,
        max_gated_file_bytes=DEFAULT_MAX_GATED_FILE_BYTES, force=False, prune=True, who="unknown"):
    """One full crawl: detect changes, convert, prune, write the three generated files.

    Returns (manifest_entries, deleted_relative_paths, removed_relative_paths, run_records),
    where run_records is the updated history, newest first, this run at index 0.
    """
    previous_manifest = load_manifest(output_root)
    previous_files = {} if force else previous_manifest["files"]
    previous_runs = previous_manifest["runs"]
    is_first_run = not previous_runs
    run_timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    long_path(output_root).mkdir(parents=True, exist_ok=True)

    manifest_entries, directory_tree_lines = crawl_and_convert(
        source_root, output_root, excluded_directory_names, max_gated_file_bytes,
        previous_files=previous_files, force=force)

    seen_source_paths = {Path(entry["relative_source_path"]).as_posix() for entry in manifest_entries}
    deleted_relative_paths = sorted(set(previous_files) - seen_source_paths)

    produced_relative_paths = [e["output_relative_path"] for e in manifest_entries if e["output_relative_path"]]
    removed_relative_paths = prune_output(output_root, produced_relative_paths) if prune else []

    run_record = build_run_record(run_timestamp, who, manifest_entries, deleted_relative_paths)
    run_records = ([run_record] + previous_runs)[:MAX_RECORDED_RUNS]

    write_manifest(output_root, source_root, excluded_directory_names, max_gated_file_bytes,
                   previous_runs, run_record, manifest_entries)
    write_index_file(output_root, source_root, manifest_entries, directory_tree_lines,
                     deleted_relative_paths)
    write_changes_file(output_root, run_timestamp, who, manifest_entries,
                       deleted_relative_paths, is_first_run)

    return manifest_entries, deleted_relative_paths, removed_relative_paths, run_records


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description="Mirror a project folder into a Markdown-only context folder for LLM consumption.")
    parser.add_argument("--source", default=None,
                        help="Folder to crawl. Defaults to the source recorded in an existing "
                             "manifest under --out, else the current directory.")
    parser.add_argument("--out", default=None,
                        help="Output folder. Defaults to <source>/local/project-to-markdown in a "
                             "git repo, else <source>/project-to-markdown.")
    parser.add_argument("--exclude", action="append", default=[], metavar="NAME",
                        help="Extra directory name to exclude, anywhere in the tree. Repeatable.")
    parser.add_argument("--max-mb", type=float, default=DEFAULT_MAX_GATED_FILE_BYTES / 1_000_000,
                        help="Size cap in MB for bulk-data files (.csv .tsv .xlsx .xls .txt).")
    parser.add_argument("--force", action="store_true",
                        help="Reprocess every file, ignoring the previous manifest.")
    parser.add_argument("--no-prune", dest="prune", action="store_false",
                        help="Leave files this run did not produce in place, instead of deleting them.")
    parser.add_argument("--as", dest="run_as", default=None, metavar="NAME",
                        help="Who is running this, recorded in the shared run history. "
                             "Defaults to your OS username. Used to work out what changed "
                             "since YOUR last run when several people share an output folder.")
    return parser.parse_args(argv)


def resolve_source_and_output(explicit_source, explicit_output):
    """Works out what to crawl and where to write it, in that order.

    Order matters. The default output is derived FROM the source, so reading the
    source back out of a manifest has to happen before the output path is settled —
    otherwise a bare re-run from a differently-mapped copy of a shared folder crawls
    one tree while writing into another. The output root is then no longer inside the
    tree being walked, self-exclusion never matches it, and the run copies a previous
    run's output (manifest and change log included) in as source material.
    """
    source_root = Path(explicit_source).resolve() if explicit_source else Path.cwd().resolve()

    if not explicit_source:
        # A manifest under the output folder remembers its source, so a bare re-run
        # needs no flags. Only trust it if it still exists — a colleague's absolute
        # path means nothing on this machine.
        probe_output_root = (Path(explicit_output).resolve() if explicit_output
                             else default_output_root(source_root).resolve())
        recorded_source_root = load_manifest(probe_output_root).get("source_root")
        if recorded_source_root and Path(recorded_source_root).is_dir():
            source_root = Path(recorded_source_root).resolve()

    output_root = (Path(explicit_output).resolve() if explicit_output
                   else default_output_root(source_root).resolve())
    return source_root, output_root


def print_since_last_run_report(run_records, who):
    """Reports what THIS person has not seen, which is rarely what this run just did.

    In a shared output folder the common case is that a colleague already crawled, so
    the current run finds nothing to do while plenty has changed since you last looked.
    """
    last_run_by_them, unseen_runs, netted_changes = changes_since_last_run_by(run_records, who)

    if last_run_by_them is None:
        if len(run_records) > 1:
            previous_run = run_records[1]
            print(f"First run for {who} against this folder — no personal history to diff against. "
                  f"It was last crawled {previous_run['at']} by {previous_run['by']}; "
                  f"see {INDEX_FILE_NAME} for the whole folder and {CHANGES_FILE_NAME} for recent history.")
        return

    headline = f"Since your last run ({last_run_by_them['at']})"
    # Only runs that actually moved something are worth reading up on.
    runs_by_others = [record for record in unseen_runs[1:]
                      if record["added"] or record["modified"] or record["deleted"]]
    if not netted_changes:
        print(f"{headline}: nothing has changed.")
        return

    print(f"{headline}: {len(netted_changes)} file(s) changed across {len(unseen_runs)} run(s).")
    for change_key, label in (("added", "Added"), ("modified", "Modified"), ("deleted", "Deleted")):
        paths = sorted(path for path, state in netted_changes.items() if state == change_key)
        if paths:
            print(f"  {label}:")
            for path in paths:
                print(f"    - {path}")
    if runs_by_others:
        # Point at the prose, which is where the "what actually happened" lives.
        print(f"  Written up in {CHANGES_FILE_NAME} under: "
              + ", ".join(f"{record['at']} ({record['by']})" for record in runs_by_others))


def main(argv=None):
    arguments = parse_arguments(argv)

    source_root, output_root = resolve_source_and_output(arguments.source, arguments.out)
    who = arguments.run_as or getpass.getuser()

    if not source_root.is_dir():
        sys.exit(f"Error: --source does not exist or is not a directory: {source_root}")

    safety_error = check_output_root_is_safe(source_root, output_root, arguments.force)
    if safety_error:
        sys.exit(f"Error: {safety_error}")

    excluded_directory_names = DEFAULT_EXCLUDED_DIRECTORY_NAMES | set(arguments.exclude)
    max_gated_file_bytes = int(arguments.max_mb * 1_000_000)

    # A colleague running with a different --exclude set silently thrashes the folder:
    # their run prunes what yours produced, yours puts it back. Say so rather than let
    # the two of you trade files forever.
    recorded_exclusions = set(load_manifest(output_root).get("excluded_directory_names", []))
    if recorded_exclusions and recorded_exclusions != excluded_directory_names:
        difference = sorted(recorded_exclusions ^ excluded_directory_names)
        print(f"Note: the last run used a different --exclude set (differs on: {', '.join(difference)}). "
              f"Files will be added or pruned to match yours.")

    manifest_entries, deleted_relative_paths, removed_relative_paths, run_records = run(
        source_root, output_root, excluded_directory_names, max_gated_file_bytes,
        force=arguments.force, prune=arguments.prune, who=who)

    action_counts = Counter(entry["action"] for entry in manifest_entries)
    change_counts = Counter(entry["change"] for entry in manifest_entries)

    print(f"Source: {source_root}")
    print(f"Output: {output_root}")
    print(f"Index:  {output_root / INDEX_FILE_NAME}")
    print(f"Run by: {who}")
    print(
        f"Converted: {action_counts['converted']} | Copied: {action_counts['copied']} | "
        f"Skipped: {action_counts['skipped']} | Over size limit: {action_counts['skipped-too-large']} | "
        f"Failed: {action_counts['failed']}"
    )
    print(
        f"Changes: added {change_counts['added']} | modified {change_counts['modified']} | "
        f"unchanged {change_counts['unchanged']} | deleted {len(deleted_relative_paths)}"
    )
    print_since_last_run_report(run_records, who)

    if removed_relative_paths:
        print(f"Pruned {len(removed_relative_paths)} stale file(s) from the output folder.")
    if action_counts["skipped-too-large"]:
        # Never let a size cap drop data silently — name every file it withheld.
        print(f"Skipped for exceeding {max_gated_file_bytes / 1_000_000:.1f} MB:")
        for entry in manifest_entries:
            if entry["action"] == "skipped-too-large":
                print(f"  - {entry['relative_source_path']} ({entry['error_message']})")
    if action_counts["failed"]:
        print("Failed files:")
        for entry in manifest_entries:
            if entry["action"] == "failed":
                print(f"  - {entry['relative_source_path']}: {entry['error_message']}")


def self_check():
    """Plain-text path end to end, without MarkItDown: copy, unchanged, modified, deleted and
    pruned, the refusal to prune the source, and per-person change tracking."""
    import tempfile

    with tempfile.TemporaryDirectory() as temporary_directory:
        source_root = Path(temporary_directory) / "project"
        output_root = Path(temporary_directory) / "context"
        (source_root / "docs").mkdir(parents=True)
        (source_root / "readme.md").write_text("hello\n")
        (source_root / "docs" / "notes.txt").write_text("notes\n")
        (source_root / "image.png").write_bytes(b"\x89PNG")
        excluded = DEFAULT_EXCLUDED_DIRECTORY_NAMES

        entries, deleted, removed, runs = run(source_root, output_root, excluded, who="alice")
        by_path = {e["relative_source_path"]: e for e in entries}
        assert by_path["readme.md"]["action"] == "copied", by_path["readme.md"]
        assert by_path["readme.md"]["change"] == "added"
        assert by_path["image.png"]["action"] == "skipped"
        assert (output_root / "docs" / "notes.txt").read_text() == "notes\n"
        for generated in GENERATED_FILE_NAMES:
            assert (output_root / generated).exists(), generated

        entries, *_ = run(source_root, output_root, excluded, who="alice")
        assert all(e["change"] == "unchanged" for e in entries), "a re-run with no edits changes nothing"

        (source_root / "readme.md").write_text("hello again\n")
        (source_root / "docs" / "notes.txt").unlink()
        entries, deleted, removed, runs = run(source_root, output_root, excluded, who="bob")
        assert {e["relative_source_path"]: e["change"] for e in entries}["readme.md"] == "modified"
        assert deleted == ["docs/notes.txt"], deleted
        assert not (output_root / "docs" / "notes.txt").exists(), "pruned from the mirror"

        last_run, unseen_runs, netted = changes_since_last_run_by(runs, "alice")
        assert netted == {"readme.md": "modified", "docs/notes.txt": "deleted"}, netted
        assert changes_since_last_run_by(runs, "carol") == (None, [], {})

        assert check_output_root_is_safe(source_root, source_root, force=False) is not None

        # A convertible file must never crash the run, with or without MarkItDown installed.
        (source_root / "deck.pptx").write_bytes(b"not really a deck")
        entries, *_ = run(source_root, output_root, excluded, who="alice")
        deck = {e["relative_source_path"]: e for e in entries}["deck.pptx"]
        assert deck["action"] in ("converted", "failed"), deck

    print("project_to_markdown self-check: ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        self_check()
    else:
        main()
