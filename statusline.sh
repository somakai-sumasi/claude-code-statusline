#!/bin/sh

# Constants
COMPACTION_THRESHOLD=160000  # 200000 * 0.8
USAGE_CACHE_FILE="$HOME/.claude/usage-cache.json"
USAGE_CACHE_TTL=60000  # milliseconds (matches JS version)

# Colors
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')
RESET=$(printf '\033[0m')

# Read JSON from stdin
INPUT="$(cat)"

# Extract values (single jq invocation)
eval "$(echo "$INPUT" | jq -r '
  @sh "MODEL=\(.model.display_name // "Unknown")",
  @sh "CURRENT_DIR=\((.workspace.current_dir // .cwd // ".") | split("/") | last)",
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "CWD=\(.workspace.current_dir // .cwd // ".")"
')"

# Git branch and dirty state
BRANCH_NAME=""
IS_DIRTY=""
if BRANCH_NAME=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null); then
  STATUS=$(git -C "$CWD" status --porcelain 2>/dev/null)
  [ -n "$STATUS" ] && IS_DIRTY="*"
else
  BRANCH_NAME=""
fi

# Calculate tokens from transcript
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

# Calculate percentage
PERCENTAGE=$((TOTAL_TOKENS * 100 / COMPACTION_THRESHOLD))
[ "$PERCENTAGE" -gt 100 ] && PERCENTAGE=100

# Format token display
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

TOKEN_DISPLAY=$(format_token_count "$TOTAL_TOKENS")

# Percentage color
PCT_COLOR="$GREEN"
[ "$PERCENTAGE" -ge 70 ] && PCT_COLOR="$YELLOW"
[ "$PERCENTAGE" -ge 90 ] && PCT_COLOR="$RED"

# Usage color helper
usage_color() {
  local util=$1
  if [ "$util" -ge 80 ]; then
    printf '%s' "$RED"
  elif [ "$util" -ge 50 ]; then
    printf '%s' "$YELLOW"
  else
    printf '%s' "$GREEN"
  fi
}

# Format reset time
format_reset_time() {
  local reset_str="$1"
  [ -z "$reset_str" ] && return

  local reset_epoch
  local cleaned
  cleaned=$(echo "$reset_str" | sed 's/\.[0-9]*//' | sed 's/+00:00$//' | sed 's/Z$//')
  reset_epoch=$(TZ=UTC date -jf "%Y-%m-%dT%H:%M:%S" "$cleaned" +%s 2>/dev/null) || return
  local now_epoch
  now_epoch=$(date +%s)
  local diff_sec=$((reset_epoch - now_epoch))
  [ "$diff_sec" -le 0 ] && echo "now" && return

  local diff_min=$((diff_sec / 60))
  local days=$((diff_min / 1440))
  local hours=$(( (diff_min % 1440) / 60 ))
  local mins=$((diff_min % 60))

  if [ "$days" -gt 0 ]; then
    echo "${days}d ${hours}h ${mins}m"
  elif [ "$hours" -gt 0 ]; then
    echo "${hours}h ${mins}m"
  else
    echo "${mins}m"
  fi
}

# Get OAuth token from macOS Keychain
get_oauth_token() {
  local raw
  raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null) || return 1
  echo "$raw" | jq -r '.claudeAiOauth.accessToken // empty'
}

# Get Claude Code version (cached)
CLAUDE_VERSION=$(claude --version 2>/dev/null | awk '{print $1; exit}' || echo "2.1.0")

# Fetch usage from API
fetch_usage() {
  local token
  token=$(get_oauth_token) || return 1
  [ -z "$token" ] && return 1

  curl -sf \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "User-Agent: claude-code/$CLAUDE_VERSION" \
    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null
}

# Get usage with cache
get_usage() {
  # Check cache
  if [ -f "$USAGE_CACHE_FILE" ]; then
    local cached_ts
    cached_ts=$(jq -r '.timestamp // 0' "$USAGE_CACHE_FILE" 2>/dev/null)
    local now_ms
    now_ms=$(date +%s)000
    local age=$(( now_ms - cached_ts ))
    if [ "$age" -lt "$USAGE_CACHE_TTL" ]; then
      jq -r '.data // empty' "$USAGE_CACHE_FILE" 2>/dev/null
      return
    fi
  fi

  # Fetch fresh
  local data
  data=$(fetch_usage)
  local now_ms
  now_ms=$(date +%s)000

  if [ -n "$data" ]; then
    jq -n --argjson ts "$now_ms" --argjson data "$data" '{"timestamp": $ts, "data": $data}' > "$USAGE_CACHE_FILE" 2>/dev/null
    echo "$data"
  else
    # API failed - write cache to prevent hammering
    if [ -f "$USAGE_CACHE_FILE" ]; then
      local fallback
      fallback=$(jq '.data // null' "$USAGE_CACHE_FILE" 2>/dev/null)
      jq -n --argjson ts "$now_ms" --argjson data "$fallback" '{"timestamp": $ts, "data": $data}' > "$USAGE_CACHE_FILE" 2>/dev/null
      echo "$fallback"
    fi
  fi
}

# Format usage display (single jq invocation)
format_usage_display() {
  local usage="$1"
  [ -z "$usage" ] && return
  [ "$usage" = "null" ] && return

  local extracted
  extracted=$(echo "$usage" | jq -r '[
    (.five_hour.utilization // null | if . then round else "" end),
    (.five_hour.resets_at // ""),
    (.seven_day.utilization // null | if . then round else "" end),
    (.seven_day.resets_at // "")
  ] | @tsv')
  [ -z "$extracted" ] && return

  local five_util five_reset seven_util seven_reset
  IFS='	' read -r five_util five_reset seven_util seven_reset <<EOF
$extracted
EOF

  local parts=""
  if [ -n "$five_util" ]; then
    local c
    c=$(usage_color "$five_util")
    local reset
    reset=$(format_reset_time "$five_reset")
    parts="5h ${c}${five_util}%${RESET} (${reset})"
  fi

  if [ -n "$seven_util" ]; then
    local c
    c=$(usage_color "$seven_util")
    local reset
    reset=$(format_reset_time "$seven_reset")
    [ -n "$parts" ] && parts="${parts} · "
    parts="${parts}7d ${c}${seven_util}%${RESET} (${reset})"
  fi

  [ -n "$parts" ] && printf '%s' "$parts"
}


# Build output
USAGE_DATA=$(get_usage)
USAGE_DISPLAY=$(format_usage_display "$USAGE_DATA")

BRANCH_DISPLAY=""
[ -n "$BRANCH_NAME" ] && BRANCH_DISPLAY=" (${BRANCH_NAME}${IS_DIRTY})"

LINE1="${CURRENT_DIR}${BRANCH_DISPLAY} · ${PCT_COLOR}${PERCENTAGE}%${RESET} (${TOKEN_DISPLAY})"

if [ -n "$USAGE_DISPLAY" ]; then
  LINE2="${MODEL} v${CLAUDE_VERSION} · ${USAGE_DISPLAY}"
else
  LINE2="${MODEL} v${CLAUDE_VERSION}"
fi

printf '%s\n%s\n' "$LINE1" "$LINE2"
