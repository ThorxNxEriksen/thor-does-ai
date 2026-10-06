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
