# thor-does-ai

A public Claude Code plugin marketplace. One plugin per folder under `plugins/`. A plugin is
shared when it has an entry in `.claude-plugin/marketplace.json`; a folder without one is a draft.
**Drafts are still public** — everything in this repo is on GitHub.

The author consumes this repo as a local-directory marketplace, so plugins load in place from this
checkout: an edit is live after `/reload-plugins`, and reaches other people only when pushed.

## Commands

```sh
git config core.hooksPath .githooks                 # once per clone: enables the pre-push privacy check
git config thor.denylist <path-to-private-list>     # once per clone: the check refuses to run without it
node scripts/privacy-check.mjs --all                # whole tree, e.g. before the first push
node scripts/privacy-check.mjs --self-check
claude plugin validate .
claude --plugin-dir plugins/<name>                  # try a draft, or a worktree's copy, for one session
```

Per-plugin checks are listed in `.github/workflows/check.yml`; run the one for the plugin you touch.

## Landmines

- **Zero hardcoded paths in any plugin.** An installed plugin lives in a versioned cache directory
  that the next update replaces. Scripts are found relative to the skill's own base directory, or
  through `${CLAUDE_PLUGIN_ROOT}` where the harness provides it. CI gate:
  `grep -rnE 'claude-perfection|claude-plugins|node ~/\.claude/skills/' plugins/` must print nothing.
- **Nothing here may describe the author's machine.** Shipped prose states the case, not the
  instance — no review row ids, no backlog references, no dates that only mean something locally.
- **The privacy check scans history, not just the tree.** A value committed and removed in the
  next commit is still published. Fixture strings that look like secrets go in
  `privacy-allow.txt`, literally, at least 8 characters each.
- **The denylist never enters this repo.** It lives in the author's private config repo, reaches
  the hook through `git config thor.denylist`, and reaches CI as the `PRIVACY_DENYLIST` secret.
  The check prints only the index of a denylist hit, never the term, because CI logs are public.
- `review-sessions`: every script guards its entry block on `realpathSync(process.argv[1])` being
  the module itself, not on argv. `status.mjs` imports `outputDir()` from `review.mjs`, and an
  argv-only guard ran a 51 s aggregation as an import side effect.
- `review-sessions`: the only configuration knob is `CLAUDE_REVIEW_DIR`. Output never goes inside
  the plugin directory, which is replaced on update.
- `review-sessions`: sessions are appended to while being read, so a transcript's last line may be
  torn. Every parse is `try { JSON.parse } catch { continue }`.

## Conventions

Node built-ins only, no `package.json`. Tests are an in-file `--self-check` per script
(`test.sh` for bash). No `version` in any `plugin.json`: users track the commit SHA.
`docs/transcript-format.md` documents the Claude Code transcript format `review-sessions` parses.
