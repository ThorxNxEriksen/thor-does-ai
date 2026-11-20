#!/bin/bash
# Pipes sample status JSON through the script and checks colours, context and the profile label.
# Runs from / so no git branch segment appears.
set -u
S="$(cd "$(dirname "$0")" && pwd)/statusline-command.sh"
fail=0
# args: model id, display name, ctx %, [context window size=200000], [effort=high]
j() { printf '{"model":{"id":"%s","display_name":"%s"},"context_window":{"used_percentage":%s,"context_window_size":%s},"effort":{"level":"%s"}}' "$1" "$2" "$3" "${4:-200000}" "${5:-high}"; }
run() { (cd / && echo "$1" | env -u CLAUDE_CONFIG_DIR ${2:+CLAUDE_CONFIG_DIR="$2"} bash "$S"); }
has() { if [[ "$3" == *"$2"* ]]; then echo "ok   $1"; else printf 'FAIL %s: want [%q] in [%q]\n' "$1" "$2" "$3"; fail=1; fi; }
is()  { if [[ "$3" == "$2" ]]; then echo "ok   $1"; else printf 'FAIL %s: want [%q] got [%q]\n' "$1" "$2" "$3"; fail=1; fi; }
YELLOW=$'\e[33m'; RED=$'\e[31m'

# "Grey" is the terminal's default colour: no escape code before the text.
is  "opus is uncoloured"  "Opus"         "$(run "$(j claude-opus-5-5 'Opus 5.5' 10)" | sed -n 1p | cut -c1-4)"
is  "fable is uncoloured" "Fable"        "$(run "$(j claude-fable-5-2 'Fable 5.2' 10)" | sed -n 1p | cut -c1-5)"
has "sonnet is yellow" "${YELLOW}Sonnet" "$(run "$(j claude-sonnet-5-5 'Sonnet 5.5' 10)" | sed -n 1p)"
has "haiku is red"     "${RED}Haiku"     "$(run "$(j claude-haiku-4-5 'Haiku 4.5' 10)" | sed -n 1p)"
has "ctx 10 is uncoloured" " | 10%"      "$(run "$(j claude-opus-5-5 Opus 10)" | sed -n 1p)"
has "ctx 45 is yellow" "${YELLOW}45%"    "$(run "$(j claude-opus-5-5 Opus 45)" | sed -n 1p)"
has "ctx 60 is red"    "${RED}60%"       "$(run "$(j claude-opus-5-5 Opus 60)" | sed -n 1p)"
has "200k variant"     "- 200k"          "$(run "$(j claude-sonnet-5-5 Sonnet 10)" | sed -n 1p)"
has "1m variant"       "- 1m"            "$(run "$(j claude-sonnet-5-5 Sonnet 10 1000000)" | sed -n 1p)"
has "opus high effort is plain"   " - high"            "$(run "$(j claude-opus-5-5 Opus 10 200000 high)" | sed -n 1p)"
has "opus medium effort is yellow" " - ${YELLOW}medium" "$(run "$(j claude-opus-5-5 Opus 10 200000 medium)" | sed -n 1p)"
has "fable medium effort is plain" " - medium"          "$(run "$(j claude-fable-5-2 Fable 10 200000 medium)" | sed -n 1p)"
has "fable high effort is yellow"  " - ${YELLOW}high"   "$(run "$(j claude-fable-5-2 Fable 10 200000 high)" | sed -n 1p)"
is  "label from a .claude-<name> dir" "colleague" "$(run "$(j x X 1)" /tmp/p/.claude-colleague | sed -n 2p)"
is  "trailing slash"   "personal"        "$(run "$(j x X 1)" /tmp/p/.claude-personal/ | sed -n 2p)"
is  "plain ~/.claude has no label" ""     "$(run "$(j x X 1)" /tmp/p/.claude | sed -n 2p)"
is  "unset has no label" ""              "$(run "$(j x X 1)" | sed -n 2p)"
exit $fail
