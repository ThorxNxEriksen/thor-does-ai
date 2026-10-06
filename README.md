# thor-does-ai

Claude Code plugins I build and use every day. Each plugin is installed on its own, so take what
you want.

```
/plugin marketplace add ThorxNxEriksen/thor-does-ai
/plugin install <plugin>@thor-does-ai
```

## Plugins

| Plugin | What it does |
|---|---|
| `statusline` | Two-line statusline. Run the `install-statusline` skill after installing. |
| `review-sessions` | Reviews your own sessions for recurring problems; `report-issue` files one as it happens. |
| `project-to-markdown` | Mirrors a project folder into Markdown for an LLM, and reports what changed since your last look. Needs `pip install "markitdown[all]"` for Office/PDF files. |
| `handoff` | Writes and resumes a handoff when a session has to stop mid-work. |
| `refactor-claude-md` | Refactors a long CLAUDE.md. Based on Matt Pocock's [AGENTS.md guide](https://www.aihero.dev/a-complete-guide-to-agents-md). |
| `profile-sync` | Walkthrough for several profiles (work, personal) from one versioned config. |

## Skills I use but did not write

Linked, not copied. Install them from their own marketplaces.

| Plugin | Where |
|---|---|
| superpowers | `claude-plugins-official` marketplace |
| andrej-karpathy-skills | github.com/forrestchang/andrej-karpathy-skills |
| ponytail | github.com/DietrichGebert/ponytail |
| diagram-design | github.com/cathrynlavery/diagram-design |
| drawio | github.com/Agents365-ai/365-skills |

## Listing a plugin (for me)

1. Its `--self-check` (or `test.sh`) passes, and it has one if it ships any script.
2. Ask Claude to review the whole plugin folder for employer, customer and personal details.
3. Add its entry to `.claude-plugin/marketplace.json` and a row to the table above.
4. `claude plugin validate .`, then push. The pre-push hook and CI run the privacy check.

## License

MIT
