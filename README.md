# claude-code-statusline

Custom status line for [Claude Code](https://claude.ai/claude-code).

Displays context window usage, API rate limits, git info, and model version in the Claude Code status bar.

## Preview

```
claude-code-statusline (main*) Sonnet 4.6 v2.1.85
ctx ⣿⣿⣿⣷ 49% (43.3K) | 5h ⣿⣿⣿⣤ 43% (1h 52m) | 7d ⣀ 3% (6d 21h 53m)
at reset                   69%                        238%
```

- **Line 1**: Directory name, git branch/dirty state, model name, version
- **Line 2**: Context window usage (% and token count), API rate limits (5-hour and 7-day with reset times)
- **Line 3** (`at reset`): Projected usage at reset time based on current consumption rate — green if under 100%, yellow if over

Color coding (green/yellow/red gradient) is applied to usage percentages.

## Setup

1. Clone this repository:

```bash
git clone https://github.com/<your-username>/claude-code-statusline.git
```

2. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/path/to/claude-code-statusline/statusline.js"
  }
}
```

## Requirements

- **Claude Code v2.1.80+** (requires `rate_limits` field in stdin JSON)
- Node.js 18+

## Features

- Context window usage with braille bar and color-coded percentage
- Token count (formatted as K/M)
- Git branch name and dirty state
- API rate limit display (5-hour and 7-day windows) with reset time countdown
- **Projected usage at reset** (`at reset` line): estimates whether you'll exhaust tokens before the window resets, based on current average consumption rate

## License

MIT
