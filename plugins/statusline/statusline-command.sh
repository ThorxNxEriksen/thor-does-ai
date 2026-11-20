#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"')
MODEL_SHORT=$(echo "$MODEL" | cut -d' ' -f1)
MODEL_ID=$(echo "$input" | jq -r '.model.id // empty')
EFFORT=$(echo "$input" | jq -r '.effort.level // empty')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

FIVE_PCT=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
FIVE_RESET=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
WEEK_PCT=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
WEEK_RESET=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

GREY=''; YELLOW='\033[33m'; RED='\033[31m'; CYAN='\033[36m'; MAGENTA='\033[35m'; RESET='\033[0m'
RED_BOLD_UL='\033[1;4;31m'

# Colored "NN%" — args: value [yellow_at=70] [red_at=90]
color_pct() {
  local p=${1:-0} y=${2:-70} r=${3:-90} c
  [[ "$p" =~ ^[0-9]+$ ]] || p=0
  if [ "$p" -ge "$r" ]; then c="$RED"
  elif [ "$p" -ge "$y" ]; then c="$YELLOW"
  else c="$GREY"; fi
  echo "${c}${p}%${RESET}"
}

# Plain "NN%", turning red only at/above the given threshold — args: value red_at
threshold_pct() {
  local p=${1:-0} r=${2}
  [[ "$p" =~ ^[0-9]+$ ]] || p=0
  if [ "$p" -ge "$r" ]; then echo "${RED}${p}%${RESET}"; else echo "${p}%"; fi
}

# Model colour (opus and fable grey / sonnet yellow / other red) and the effort that counts as normal for it
NORMAL_EFFORT="high"
case "$(echo "$MODEL_ID $MODEL" | tr '[:upper:]' '[:lower:]')" in
  *opus*) MC="$GREY" ;;
  *fable*) MC="$GREY"; NORMAL_EFFORT="medium" ;;
  *sonnet*) MC="$YELLOW" ;;
  *) MC="$RED" ;;
esac

# Effort suffix (omitted if the model has no effort setting); yellow when it is not the model's normal effort
EFFORT_SEG=""
if [ -n "$EFFORT" ]; then
  if [ "$EFFORT" = "$NORMAL_EFFORT" ]; then
    EFFORT_SEG=" - $EFFORT"
  else
    EFFORT_SEG=" - ${YELLOW}${EFFORT}${RESET}"
  fi
fi

# Context-window size as Claude Code reports it (the model id no longer carries a [1m] marker)
CTX_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
if [ "$CTX_SIZE" -ge 1000000 ]; then
  VARIANT="$((CTX_SIZE / 1000000))m"
else
  VARIANT="$((CTX_SIZE / 1000))k"
fi

# Line 1: model - effort | ctx% - variant | branch
# Line 2: profile | 5h | 7d
# colored: model (see above), ctx% (grey / yellow 45 / red 60), 5h% (red 75), 7d% (red 90), branch (magenta)

LINE1="${MC}${MODEL_SHORT}${RESET}${EFFORT_SEG} | $(color_pct "$PCT" 45 60) - ${VARIANT}"

# Branch to the right of line 1, as "current -> target"
# target = whatever this branch was cut from (per its reflog), else the repo's default branch
if git rev-parse --git-dir > /dev/null 2>&1; then
  B=$(git branch --show-current 2>/dev/null)
  if [ -n "$B" ]; then
    TARGET=$(git reflog show "$B" 2>/dev/null | tail -1 | sed -n 's/.*branch: Created from //p')
    case "$TARGET" in
      ""|HEAD) TARGET=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) ;;
    esac
    TARGET=${TARGET#origin/}

    # Working directly on a protected branch is the thing worth shouting about
    case "$B" in
      main|master|prod|production) BSEG="${RED_BOLD_UL}${B}${RESET}" ;;
      *) BSEG="${MAGENTA}${B}${RESET}" ;;
    esac
    [ -n "$TARGET" ] && [ "$TARGET" != "$B" ] && BSEG="${BSEG} -> ${TARGET}"

    LINE1="${LINE1} | ${BSEG}"
  fi
fi

# Which profile this session runs in: ~/.claude-work -> "work". Nothing for plain ~/.claude.
LINE2=""
CFG="${CLAUDE_CONFIG_DIR%/}"
case "$CFG" in
  ""|*/.claude) ;;
  *) LINE2="$(basename "$CFG")"; LINE2="${LINE2#.claude-}" ;;
esac

if [ -n "$FIVE_PCT" ]; then
  FIVE_PCT_INT=$(printf '%.0f' "$FIVE_PCT")
  FIVE_RESET_FMT=$(date -d "@${FIVE_RESET}" +%H:%M 2>/dev/null || date -r "${FIVE_RESET}" +%H:%M 2>/dev/null || echo "?")
  SEG="5h: $(threshold_pct "$FIVE_PCT_INT" 75) (${FIVE_RESET_FMT})"
  [ -n "$LINE2" ] && LINE2="${LINE2} | ${SEG}" || LINE2="${SEG}"
fi
if [ -n "$WEEK_PCT" ]; then
  WEEK_PCT_INT=$(printf '%.0f' "$WEEK_PCT")
  WEEK_RESET_FMT=$(date -d "@${WEEK_RESET}" +%a\ %H:%M 2>/dev/null || date -r "${WEEK_RESET}" +%a\ %H:%M 2>/dev/null || echo "?")
  SEG="7d: $(threshold_pct "$WEEK_PCT_INT" 90) (${WEEK_RESET_FMT})"
  [ -n "$LINE2" ] && LINE2="${LINE2} | ${SEG}" || LINE2="${SEG}"
fi

echo -e "$LINE1"
echo -e "$LINE2"
