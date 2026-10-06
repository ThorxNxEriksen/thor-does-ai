#!/bin/bash
# Pipes sample status JSON through the script and checks colours, context and the profile label.
# Runs from / so no git branch segment appears.
set -u
S="$(cd "$(dirname "$0")" && pwd)/statusline-command.sh"
fail=0
j() { printf '{"model":{"id":"%s","display_name":"%s"},"context_window":{"used_percentage":%s}}' "$1" "$2" "$3"; }
run() { (cd / && echo "$1" | env -u CLAUDE_CONFIG_DIR ${2:+CLAUDE_CONFIG_DIR="$2"} bash "$S"); }
has() { if [[ "$3" == *"$2"* ]]; then echo "ok   $1"; else printf 'FAIL %s: want [%q] in [%q]\n' "$1" "$2" "$3"; fail=1; fi; }
is()  { if [[ "$3" == "$2" ]]; then echo "ok   $1"; else printf 'FAIL %s: want [%q] got [%q]\n' "$1" "$2" "$3"; fail=1; fi; }
GREY=$'\e[90m'; YELLOW=$'\e[33m'; RED=$'\e[31m'

has "opus is grey"     "${GREY}Opus"     "$(run "$(j claude-opus-5-5 'Opus 5.5' 10)" | sed -n 1p)"
has "sonnet is yellow" "${YELLOW}Sonnet" "$(run "$(j claude-sonnet-5-5 'Sonnet 5.5' 10)" | sed -n 1p)"
has "haiku is red"     "${RED}Haiku"     "$(run "$(j claude-haiku-4-5 'Haiku 4.5' 10)" | sed -n 1p)"
has "ctx 10 is grey"   "${GREY}10%"      "$(run "$(j claude-opus-5-5 Opus 10)" | sed -n 1p)"
has "ctx 45 is yellow" "${YELLOW}45%"    "$(run "$(j claude-opus-5-5 Opus 45)" | sed -n 1p)"
has "ctx 60 is red"    "${RED}60%"       "$(run "$(j claude-opus-5-5 Opus 60)" | sed -n 1p)"
has "1m variant"       "- 1m"            "$(run "$(j 'claude-sonnet-5-5[1m]' Sonnet 10)" | sed -n 1p)"
is  "label from a .claude-<name> dir" "colleague" "$(run "$(j x X 1)" /tmp/p/.claude-colleague | sed -n 2p)"
is  "trailing slash"   "personal"        "$(run "$(j x X 1)" /tmp/p/.claude-personal/ | sed -n 2p)"
is  "plain ~/.claude has no label" ""     "$(run "$(j x X 1)" /tmp/p/.claude | sed -n 2p)"
is  "unset has no label" ""              "$(run "$(j x X 1)" | sed -n 2p)"
exit $fail
