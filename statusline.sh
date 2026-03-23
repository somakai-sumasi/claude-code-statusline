#!/bin/sh

# ==== Constants ====
COMPACTION_THRESHOLD=160000  # 200000 * 0.8

# ==== UI helpers ====
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')
RESET=$(printf '\033[0m')

color_by_pct() {
  local pct=$1
  if [ "$pct" -ge 90 ]; then printf '%s' "$RED"
  elif [ "$pct" -ge 70 ]; then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"
  fi
}

color_by_usage() {
  local util=$1
  if [ "$util" -ge 80 ]; then printf '%s' "$RED"
  elif [ "$util" -ge 50 ]; then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"
  fi
}

format_token_count() {
  local tokens=$1
  if [ "$tokens" -ge 1000000 ]; then
    awk "BEGIN { printf \"%.1fM\", $tokens / 1000000 }"
  elif [ "$tokens" -ge 1000 ]; then
    awk "BEGIN { printf \"%.1fK\", $tokens / 1000 }"
  else
    echo "$tokens"
  fi
}

format_duration() {
  local diff_sec=$1
  [ "$diff_sec" -le 0 ] && echo "now" && return

  local diff_min=$((diff_sec / 60))
  local days=$((diff_min / 1440))
  local hours=$(( (diff_min % 1440) / 60 ))
  local mins=$((diff_min % 60))

  if [ "$days" -gt 0 ]; then echo "${days}d ${hours}h ${mins}m"
  elif [ "$hours" -gt 0 ]; then echo "${hours}h ${mins}m"
  else echo "${mins}m"
  fi
}

# ==== Data collection ====

INPUT="$(cat)"

eval "$(echo "$INPUT" | jq -r '
  @sh "MODEL=\(.model.display_name // "Unknown")",
  @sh "CURRENT_DIR=\((.workspace.current_dir // .cwd // ".") | split("/") | last)",
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "CWD=\(.workspace.current_dir // .cwd // ".")",
  @sh "FIVE_HOUR_PCT=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "FIVE_HOUR_RESET=\(.rate_limits.five_hour.resets_at // "")",
  @sh "SEVEN_DAY_PCT=\(.rate_limits.seven_day.used_percentage // "")",
  @sh "SEVEN_DAY_RESET=\(.rate_limits.seven_day.resets_at // "")"
')"

BRANCH_NAME=""
IS_DIRTY=""
if BRANCH_NAME=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null); then
  STATUS=$(git -C "$CWD" status --porcelain 2>/dev/null)
  [ -n "$STATUS" ] && IS_DIRTY="*"
else
  BRANCH_NAME=""
fi

TOTAL_TOKENS=0
if [ -n "$SESSION_ID" ]; then
  PROJECTS_DIR="$HOME/.claude/projects"
  if [ -d "$PROJECTS_DIR" ]; then
    for PROJECT_DIR in "$PROJECTS_DIR"/*/; do
      TRANSCRIPT_FILE="${PROJECT_DIR}${SESSION_ID}.jsonl"
      if [ -f "$TRANSCRIPT_FILE" ]; then
        LAST_USAGE=$(grep '"type":"assistant"' "$TRANSCRIPT_FILE" | grep '"usage"' | tail -1 | jq -r '.message.usage // empty')
        if [ -n "$LAST_USAGE" ]; then
          TOTAL_TOKENS=$(echo "$LAST_USAGE" | jq '(.input_tokens // 0) + (.output_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)')
        fi
        break
      fi
    done
  fi
fi

CLAUDE_VERSION=$(claude --version 2>/dev/null | awk '{print $1; exit}' || echo "2.1.0")
NOW_EPOCH=$(date +%s)

# ==== Rendering ====

PERCENTAGE=$((TOTAL_TOKENS * 100 / COMPACTION_THRESHOLD))
[ "$PERCENTAGE" -gt 100 ] && PERCENTAGE=100

BRANCH_DISPLAY=""
[ -n "$BRANCH_NAME" ] && BRANCH_DISPLAY=" (${BRANCH_NAME}${IS_DIRTY})"

LINE1="${CURRENT_DIR}${BRANCH_DISPLAY} · $(color_by_pct "$PERCENTAGE")${PERCENTAGE}%${RESET} ($(format_token_count "$TOTAL_TOKENS"))"

render_usage_part() {
  local label=$1 pct=$2 reset_epoch=$3
  [ -z "$pct" ] && return
  local rounded
  rounded=$(printf '%.0f' "$pct")
  local part="${label} $(color_by_usage "$rounded")${rounded}%${RESET}"
  if [ -n "$reset_epoch" ]; then
    local reset
    reset=$(format_duration $((reset_epoch - NOW_EPOCH)))
    [ -n "$reset" ] && part="${part} (${reset})"
  fi
  printf '%s' "$part"
}

USAGE_PARTS=""
for entry in "5h|${FIVE_HOUR_PCT}|${FIVE_HOUR_RESET}" "7d|${SEVEN_DAY_PCT}|${SEVEN_DAY_RESET}"; do
  label=$(echo "$entry" | cut -d'|' -f1)
  pct=$(echo "$entry" | cut -d'|' -f2)
  reset_epoch=$(echo "$entry" | cut -d'|' -f3)
  part=$(render_usage_part "$label" "$pct" "$reset_epoch")
  if [ -n "$part" ]; then
    [ -n "$USAGE_PARTS" ] && USAGE_PARTS="${USAGE_PARTS} · "
    USAGE_PARTS="${USAGE_PARTS}${part}"
  fi
done

LINE2="${MODEL} v${CLAUDE_VERSION}"
[ -n "$USAGE_PARTS" ] && LINE2="${LINE2} · ${USAGE_PARTS}"

printf '%s\n%s\n' "$LINE1" "$LINE2"
