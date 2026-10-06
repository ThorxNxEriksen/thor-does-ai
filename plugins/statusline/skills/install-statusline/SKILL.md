---
name: install-statusline
description: Install or update the thor-does-ai statusline in the current Claude Code profile. Use when the user says "install the statusline", "set up thor's statusline", "update my statusline", or asks how to get this statusline.
---

# Install the statusline

A plugin cannot set the main statusline, so this copies the script into the user's profile and
points `statusLine` at it. Running it again updates the copy.

## Steps

1. **Check `jq`.** Run `command -v jq`. If it prints nothing, tell the user the script needs `jq`
   (`brew install jq` on macOS, `sudo apt install jq` on Debian/Ubuntu) and stop.
2. **Find the profile.** It is `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. Call it `<profile>`.
3. **Copy the script.** Copy `statusline-command.sh` from this plugin (two directories above
   this skill's base directory) to `<profile>/statusline-command.sh` and `chmod 755` it. If a file
   is already there and differs, show the diff and ask before replacing it — it may hold the
   user's own edits.
4. **Point `statusLine` at it.** Read `<profile>/settings.json`. The entry to set is

   ```json
   "statusLine": { "type": "command", "command": "bash \"$HOME/<profile relative to $HOME>/statusline-command.sh\"" }
   ```

   using `$HOME`-relative form when `<profile>` is under the home directory, and the absolute path
   otherwise. If `statusLine` already exists with a different command, show both and ask before
   replacing. Never rewrite other keys.
5. **Tell the user what they got**, in four lines:
   - Line 1: model (Opus grey, Sonnet yellow, any other model red), effort, context % and
     window size, git branch (protected branches `main`/`master`/`prod`/`production` in bold red).
   - Context %: grey below 45, yellow from 45, red from 60. Change the `45 60` passed to
     `color_pct` in the script to move them.
   - Line 2: the profile name (from a `~/.claude-<name>` directory), then 5-hour usage (red from
     75%) and 7-day usage (red from 90%) with their reset times.
   - It updates only when they run this skill again.
