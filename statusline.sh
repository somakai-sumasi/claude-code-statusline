#!/bin/sh

# ==== Constants ====
COMPACTION_THRESHOLD=160000  # 200000 * 0.8

# ==== UI helpers ====
RESET=$(printf '\033[0m')
LABEL=$(printf '\033[38;2;140;140;140m')

gradient() {
  local pct=$1
  if [ "$pct" -lt 50 ]; then
    local r=$((pct * 51 / 10))
    printf '\033[38;2;%d;200;80m' "$r"
  else
    local g=$((200 - (pct - 50) * 4))
    [ "$g" -lt 0 ] && g=0
    printf '\033[38;2;255;%d;60m' "$g"
  fi
}

braille_bar() {
  local pct=$1
  local width=${2:-8}
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100
  local chars=' ⣀⣄⣤⣦⣶⣷⣿'
  local bar=""
  local i=0
  while [ "$i" -lt "$width" ]; do
    local seg_start_x100=$((i * 10000 / width))
    local seg_end_x100=$(((i + 1) * 10000 / width))
    local level_x100=$((pct * 100))
    if [ "$level_x100" -ge "$seg_end_x100" ]; then
      bar="${bar}$(echo "$chars" | cut -c8)"
    elif [ "$level_x100" -le "$seg_start_x100" ]; then
      bar="${bar} "
    else
      local frac_x7=$(( (level_x100 - seg_start_x100) * 7 / (seg_end_x100 - seg_start_x100) ))
      [ "$frac_x7" -gt 7 ] && frac_x7=7
      local idx=$((frac_x7 + 1))
      bar="${bar}$(echo "$chars" | cut -c${idx})"
    fi
    i=$((i + 1))
  done
  printf '%s' "$bar"
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

LINE1="${CURRENT_DIR}${BRANCH_DISPLAY} ${MODEL} v${CLAUDE_VERSION}"
CTX_PART="${LABEL}ctx${RESET} $(gradient "$PERCENTAGE")$(braille_bar "$PERCENTAGE") ${PERCENTAGE}%${RESET} ($(format_token_count "$TOTAL_TOKENS"))"

render_usage_part() {
  local label=$1 pct=$2 reset_epoch=$3
  [ -z "$pct" ] && return
  local rounded
  rounded=$(printf '%.0f' "$pct")
  local part="${LABEL}${label}${RESET} $(gradient "$rounded")$(braille_bar "$rounded") ${rounded}%${RESET}"
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
    [ -n "$USAGE_PARTS" ] && USAGE_PARTS="${USAGE_PARTS} | "
    USAGE_PARTS="${USAGE_PARTS}${part}"
  fi
done

LINE2="${CTX_PART}"
[ -n "$USAGE_PARTS" ] && LINE2="${LINE2} | ${USAGE_PARTS}"

printf '%s\n%s\n' "$LINE1" "$LINE2"
