# claude-code-statusline

Custom status line for [Claude Code](https://claude.ai/claude-code).

Displays context window usage, API rate limits, git info, and model version in the Claude Code status bar.

## Preview

```
for_study (main*) · 81% (130.3K)
Opus 4.6 v2.1.72 · 5h 8% (4h 18m) · 7d 15% (1d 19h 18m)
```

- **Line 1**: Directory name, git branch/dirty state, context window usage (% and token count)
- **Line 2**: Model name, Claude Code version, API rate limits (5-hour and 7-day with reset times)

Color coding (green/yellow/red) is applied to usage percentages.

## Variants

| File | Runtime | Dependencies |
|------|---------|-------------|
| `statusline.js` | Node.js 18+ | None (built-in modules only) |
| `statusline.sh` | POSIX sh | `jq`, `curl` |

## Setup

1. Clone this repository and create a symlink:

```bash
git clone https://github.com/<your-username>/claude-code-statusline.git

# Node.js version
ln -s "$(pwd)/claude-code-statusline/statusline.js" ~/.claude/statusline.js

# Or shell version
ln -s "$(pwd)/claude-code-statusline/statusline.sh" ~/.claude/statusline.sh
```

2. Make sure the script is executable:

```bash
chmod +x ~/.claude/statusline.js  # or statusline.sh
```

3. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.js"
  }
}
```

Replace `statusline.js` with `statusline.sh` if using the shell version.

## Features

- Context window usage with color-coded percentage (green < 70% < yellow < 90% < red)
- Token count (formatted as K/M)
- Git branch name and dirty state
- API rate limit display (5-hour and 7-day windows)
- Rate limit reset time countdown
- Usage data caching (60s TTL) to avoid excessive API calls
- OAuth token retrieval from macOS Keychain

## Requirements

### Node.js version
- Node.js 18+ (for built-in `fetch`)

### Shell version
- `jq` for JSON parsing
- `curl` for API requests
- macOS `security` command (for Keychain access)
- macOS `date` (BSD variant)

## License

MIT
