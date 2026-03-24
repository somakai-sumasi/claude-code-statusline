#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

// ==== Constants ====
const MINUTES_PER_DAY = 1440;

// ==== UI helpers ====
const BRAILLE = ' ⣀⣄⣤⣦⣶⣷⣿';
const RESET = '\x1b[0m';
const LABEL = '\x1b[38;2;140;140;140m';

function gradient(pct) {
  if (pct < 50) {
    const r = Math.floor(pct * 5.1);
    return `\x1b[38;2;${r};200;80m`;
  }
  const g = Math.max(Math.floor(200 - (pct - 50) * 4), 0);
  return `\x1b[38;2;255;${g};60m`;
}

function brailleBar(pct, width = 8) {
  pct = Math.min(Math.max(pct, 0), 100);
  const level = pct / 100;
  let bar = '';
  for (let i = 0; i < width; i++) {
    const segStart = i / width;
    const segEnd = (i + 1) / width;
    if (level >= segEnd) {
      bar += BRAILLE[7];
    } else if (level <= segStart) {
      bar += BRAILLE[0];
    } else {
      const frac = (level - segStart) / (segEnd - segStart);
      bar += BRAILLE[Math.min(Math.floor(frac * 7), 7)];
    }
  }
  return bar;
}

function formatTokenCount(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
}

function formatDuration(diffSec) {
  if (diffSec <= 0) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  const days = Math.floor(diffMin / MINUTES_PER_DAY);
  const hours = Math.floor((diffMin % MINUTES_PER_DAY) / 60);
  const mins = diffMin % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ==== Data collection ====

function getGitInfo(cwd) {
  try {
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const status = execSync('git status --porcelain', { cwd, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return { branchName, isDirty: status.length > 0 };
  } catch {
    return { branchName: '', isDirty: false };
  }
}

function collectData(input) {
  const data = JSON.parse(input);
  const cwd = data.workspace?.current_dir || data.cwd || '.';
  const ctx = data.context_window || {};

  return {
    model: data.model?.display_name || 'Unknown',
    currentDir: path.basename(cwd),
    git: getGitInfo(cwd),
    totalTokens: (ctx.total_input_tokens || 0) + (ctx.total_output_tokens || 0),
    usedPercentage: ctx.used_percentage ?? 0,
    rateLimits: data.rate_limits || null,
    version: data.version || '',
  };
}

// ==== Rendering ====

function render(ctx) {
  const nowEpoch = Math.floor(Date.now() / 1000);

  const pct = Math.min(100, ctx.usedPercentage);
  const branchDisplay = ctx.git.branchName ? ` (${ctx.git.branchName}${ctx.git.isDirty ? '*' : ''})` : '';
  const line1 = `${ctx.currentDir}${branchDisplay} ${ctx.model} v${ctx.version}`;
  const ctxPart = `${LABEL}ctx${RESET} ${gradient(pct)}${brailleBar(pct)} ${pct}%${RESET} (${formatTokenCount(ctx.totalTokens)})`;

  const RATE_LIMIT_KEYS = [
    { key: 'five_hour', label: '5h' },
    { key: 'seven_day', label: '7d' },
  ];

  const usageParts = RATE_LIMIT_KEYS
    .filter(({ key }) => ctx.rateLimits?.[key])
    .map(({ key, label }) => {
      const u = Math.round(ctx.rateLimits[key].used_percentage);
      let part = `${LABEL}${label}${RESET} ${gradient(u)}${brailleBar(u)} ${u}%${RESET}`;
      if (ctx.rateLimits[key].resets_at) part += ` (${formatDuration(ctx.rateLimits[key].resets_at - nowEpoch)})`;
      return part;
    });

  const line2Parts = [ctxPart];
  if (usageParts.length) line2Parts.push(...usageParts);

  return `${line1}\n${line2Parts.join(' | ')}`;
}

// ==== Main ====

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const ctx = collectData(input);
    console.log(render(ctx));
  } catch {
    console.log('[Error] . | 0 | 0%');
  }
});
