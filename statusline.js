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
    const status = execSync('git status --porcelain', { cwd, stdio: ['pipe', 'pipe', 'ignore'] }).toString().replace(/\n$/, '');
    const lines = status ? status.split('\n') : [];
    const modified = lines.filter(l => l[1] !== ' ' && l[1] !== '?').length;
    const untracked = lines.filter(l => l[0] === '?' && l[1] === '?').length;
    return { branchName, isDirty: lines.length > 0, modified, untracked };
  } catch {
    return { branchName: '', isDirty: false, modified: 0, untracked: 0 };
  }
}

function collectData(input) {
  const data = JSON.parse(input);
  const cwd = data.workspace?.current_dir || data.cwd || '.';
  const ctx = data.context_window || {};

  return {
    model: data.model?.display_name || 'Unknown',
    currentDir: path.basename(cwd),
    currentDirFull: cwd,
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

  const GREEN = '\x1b[38;2;80;200;80m';
  const YELLOW = '\x1b[38;2;255;200;60m';

  const pct = Math.min(100, ctx.usedPercentage);
  let gitChanges = '';
  if (ctx.git.untracked > 0) gitChanges += ` ${GREEN}+${ctx.git.untracked}${RESET}`;
  if (ctx.git.modified > 0) gitChanges += ` ${YELLOW}~${ctx.git.modified}${RESET}`;
  const dirty = ctx.git.isDirty && ctx.git.modified === 0 && ctx.git.untracked === 0;
  const branchDisplay = ctx.git.branchName ? ` (${ctx.git.branchName}${dirty ? '*' : ''}${gitChanges})` : '';
  const UNDERLINE = '\x1b[4m';
  const dirLink = `\x1b]8;;vscode://file${ctx.currentDirFull}\x07${UNDERLINE}${ctx.currentDir}${RESET}\x1b]8;;\x07`;
  const line1 = `${dirLink}${branchDisplay} ${ctx.model} v${ctx.version}`;
  const ctxPart = `${LABEL}ctx${RESET} ${gradient(pct)}${brailleBar(pct)} ${pct}%${RESET} (${formatTokenCount(ctx.totalTokens)})`;

  const RATE_LIMIT_KEYS = [
    { key: 'five_hour', label: '5h', windowSec: 5 * 3600 },
    { key: 'seven_day', label: '7d', windowSec: 7 * 24 * 3600 },
  ];

  const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;

  const entries = RATE_LIMIT_KEYS
    .filter(({ key }) => ctx.rateLimits?.[key])
    .map(({ key, label, windowSec }) => {
      const rl = ctx.rateLimits[key];
      const u = Math.round(rl.used_percentage);
      let usagePart = `${LABEL}${label}${RESET} ${gradient(u)}${brailleBar(u)} ${u}%${RESET}`;
      if (rl.resets_at) usagePart += ` (${formatDuration(rl.resets_at - nowEpoch)})`;

      let projPart = null;
      if (rl.resets_at) {
        const remainSec = rl.resets_at - nowEpoch;
        const elapsedSec = windowSec - remainSec;
        if (elapsedSec > 60 && u > 0) {
          const projected = Math.round((u / elapsedSec) * windowSec);
          const projColor = projected >= 100 ? '\x1b[38;2;255;200;0m' : '\x1b[38;2;80;200;80m';
          projPart = `${projColor}${Math.min(projected, 999)}%${RESET}`;
        }
      }
      return { usagePart, projPart, label };
    });

  const line2Parts = [ctxPart, ...entries.map(e => e.usagePart)];
  const lines = [`${line1}`, line2Parts.join(' | ')];

  if (entries.some(e => e.projPart)) {
    // "at reset"(8) + pad → align under pct: ctxPart + " | "(3) + label(2)+" "+bar(8)+" "(1) - 8 = +7
    const pad = ' '.repeat(visibleLen(ctxPart) + 7);
    const projSegments = entries.map((e, i) => {
      const isLast = i === entries.length - 1;
      if (!e.projPart) return isLast ? '' : ' '.repeat(visibleLen(e.usagePart) + 3);
      const gap = isLast ? '' : ' '.repeat(Math.max(0, visibleLen(e.usagePart) + 3 - visibleLen(e.projPart)));
      return e.projPart + gap;
    });
    while (projSegments.length && projSegments[projSegments.length - 1] === '') projSegments.pop();
    lines.push(`${LABEL}at reset${RESET}${pad}${projSegments.join('')}`);
  }

  return lines.join('\n');
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
