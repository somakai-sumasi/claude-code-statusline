# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code ステータスラインスクリプト。メインファイルは `statusline.js` 1ファイルのみ。Node.js で動作し、stdin から JSON を受け取って stdout にステータス文字列を出力する。

## セットアップ

`~/.claude/settings.json` に追加：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/ghq/claude-code-statusline/statusline.js"
  }
}
```

## テスト方法

`current_dir` はgit情報取得に使うので実在するgitリポジトリのパスを指定すること：

```bash
echo '{"model":{"display_name":"Sonnet 4.6"},"workspace":{"current_dir":"'$PWD'"},"context_window":{"used_percentage":42,"total_input_tokens":80000,"total_output_tokens":5000},"rate_limits":{"five_hour":{"used_percentage":65,"resets_at":9999999999},"seven_day":{"used_percentage":30,"resets_at":9999999999}},"version":"2.1.80"}' | node statusline.js
```

## アーキテクチャ

`statusline.js` は3層構造：

1. **UI helpers** — `gradient(pct)` でTrueColor ANSI生成、`brailleBar(pct, width)` でブライユ文字ゲージ描画
2. **Data collection** — `getGitInfo(cwd)` でgit情報取得、`collectData(input)` でstdin JSONをパース
3. **Rendering** — `render(ctx)` で3行の出力を組み立て

### 出力フォーマット

- **Line 1**: `dirname (branch +staged ~modified) model vX.X.X`
- **Line 2**: `ctx ゲージ XX% (tokens) | 5h ゲージ XX% (reset残時間) | 7d ゲージ XX% (reset残時間)`
- **Line 3** (rate limitがある場合のみ): `at reset` + projected usage (リセット時点での予測使用率、緑=100%未満/黄=超過)

### stdin JSONの主要フィールド

- `rate_limits.five_hour` / `rate_limits.seven_day`: `{ used_percentage, resets_at (unixtime) }`
- `context_window`: `{ used_percentage, total_input_tokens, total_output_tokens }`
- `workspace.current_dir`: git操作に使用

### 注意事項

- `at reset` 行のパディングは `visibleLen(ctxPart) + 7` で計算しており、ANSIエスケープを除いた可視文字長に依存する。ctxPart の表示内容が変わるとずれるため要注意
