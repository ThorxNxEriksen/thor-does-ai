---
name: profile-sync-walkthrough
description: Walk the user through running several Claude Code profiles (e.g. work and personal accounts) from one git-versioned config, using CLAUDE_CONFIG_DIR, symlinks and shell wrappers. Use when the user asks how to set up multiple Claude accounts or profiles, how to keep their config in sync between profiles, or how to version-control their Claude Code setup.
---

# Several Claude Code profiles, one config

This is a guide, not an installer. Build it with the user in **their** repo, one step at a time,
and ask before each change to their home directory. Adapt names to theirs.

## 1. The problem

Claude Code keeps everything for one login in a config directory: `~/.claude` by default, or
whatever `CLAUDE_CONFIG_DIR` points at. Two accounts (say work and personal) means two
directories, and every edit to `CLAUDE.md`, `settings.json`, a hook or a skill has to be made
twice. They drift within a week.

Ask the user: which profiles do they want, and which account logs into each?

## 2. The pattern: a repo is the source, each profile is symlinks into it

```
~/dev/my-claude-config/home/claude/   the source, in git
  settings.json  CLAUDE.md  statusline-command.sh  hooks/  commands/  agents/  skills/

~/.claude-work/settings.json   -> ~/dev/my-claude-config/home/claude/settings.json
~/.claude-work/skills          -> ~/dev/my-claude-config/home/claude/skills
~/.claude-personal/...         -> the same targets
```

Link those seven entries. **Never link** `.credentials.json`, `.claude.json`, `projects/`,
`plugins/`, `sessions/` or anything else Claude Code writes as state: that is per-login and
per-machine.

Write a small installer that, for every `~/.claude*` directory it finds, creates each link and
refuses to overwrite a real file without asking (offer to move it into the repo first). Make it
idempotent and give it a dry-run default. Discover profiles by listing `~/.claude*` directories;
never hardcode how many there are.

## 3. Choosing a profile

Shell wrappers, sourced from `~/.zshrc` or `~/.bashrc`:

```sh
claude-work()     { CLAUDE_CONFIG_DIR="$HOME/.claude-work"     command claude "$@" }
claude-personal() { CLAUDE_CONFIG_DIR="$HOME/.claude-personal" command claude "$@" }
claude() {
  echo "Pick a profile: claude-work or claude-personal" >&2
  return 1
}
```

`command` is load-bearing: without it the wrappers recurse into the `claude` function. The nudge
on bare `claude` stops accidental launches into the wrong account. Keep plain `~/.claude` logged
in anyway: IDE integrations and `claude -p` in scripts do not load your shell rc and use it.

## 4. Things that surprise everyone

- **Each config directory is its own login.** On macOS the keychain entry is keyed by
  `CLAUDE_CONFIG_DIR` when it is set, and by a suffix-less name when it is not. So
  `CLAUDE_CONFIG_DIR=~/.claude claude` is not the same login as plain `claude`, and renaming a
  profile directory costs a fresh `/login`.
- **claude.ai connectors follow the account, not the directory.** Connectors added on claude.ai
  (Notion, Google Drive, ...) are fetched per session with that profile's login. No symlink or
  copy can share them; connect them in each account.
- **MCP servers are per profile.** `mcpServers` lives in each profile's `.claude.json`, which is
  not linked. Add a server to each profile by running
  `CLAUDE_CONFIG_DIR=<profile> claude mcp add <name> ... --scope user` once per profile, and
  verify by reading each `.claude.json`. `claude mcp list` only sees the profile it runs in.
- **Writes through a symlinked directory land in your repo.** Anything Claude Code drops into
  `skills/` or `agents/` appears in git. Make `.gitignore` under `home/` an allowlist of what you
  mean to track, and never `git add .` there.
- **Claude Code writes `settings.json` safely through the link.** `/theme`, `/model` and
  `/plugin` resolve the symlink and rewrite the repo file, so those changes show up in
  `git diff`. Review them before committing: `/model` will happily save `opus` over `opus[1m]`.
- **Claude's own Write and Edit tools refuse to write to a symlink path.** Edit the repo file
  instead. A `PreToolUse` hook that denies edits through `~/.claude*` and names the repo file
  makes that refusal self-explanatory.
- **Every change is live everywhere, immediately.** There is no apply step; git is the rollback,
  but only for what is committed.

## 5. Windows

Creating symlinks may need Developer Mode or an elevated shell. If symlinks are not an option,
the fallback is a launcher that copies the repo's files into the profile on every start: simpler
to set up, but each profile is then a snapshot that drifts until the next launch.

## 6. Done when

- Each wrapper starts the right account (`/status` shows it).
- Editing `CLAUDE.md` in the repo changes every profile's next session.
- `git status` in the repo shows nothing unexpected after a day of use.

---

Last checked against Claude Code 2.1.291 on macOS, 2026-10-06.
