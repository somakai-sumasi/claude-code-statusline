#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

// ==== Constants ====
const COMPACTION_THRESHOLD = 200000 * 0.8;
const MINUTES_PER_DAY = 1440;

// ==== UI helpers ====
const COLORS = { GREEN: '\x1b[32m', YELLOW: '\x1b[33m', RED: '\x1b[31m', RESET: '\x1b[0m' };

function colorByPct(pct) {
  if (pct >= 90) return COLORS.RED;
  if (pct >= 70) return COLORS.YELLOW;
  return COLORS.GREEN;
}

function colorByUsage(util) {
  if (util >= 80) return COLORS.RED;
  if (util >= 50) return COLORS.YELLOW;
  return COLORS.GREEN;
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

function getClaudeVersion() {
  try {
    return execSync('claude --version', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split(/\s+/)[0] || '2.1.0';
  } catch {
    return '2.1.0';
  }
}

async function calculateTokensFromTranscript(filePath) {
  return new Promise((resolve, reject) => {
    let lastUsage = null;
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message?.usage) {
          lastUsage = entry.message.usage;
        }
      } catch {}
    });

    rl.on('close', () => {
      if (lastUsage) {
        resolve(
          (lastUsage.input_tokens || 0) +
          (lastUsage.output_tokens || 0) +
          (lastUsage.cache_creation_input_tokens || 0) +
          (lastUsage.cache_read_input_tokens || 0)
        );
      } else {
        resolve(0);
      }
    });

    rl.on('error', reject);
  });
}

async function collectData(input) {
  const data = JSON.parse(input);
  const cwd = data.workspace?.current_dir || data.cwd || '.';

  let totalTokens = 0;
  if (data.session_id) {
    const projectsDir = path.join(process.env.HOME, '.claude', 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const dir of fs.readdirSync(projectsDir)) {
        const fullDir = path.join(projectsDir, dir);
        if (!fs.statSync(fullDir).isDirectory()) continue;
        const transcriptFile = path.join(fullDir, `${data.session_id}.jsonl`);
        if (fs.existsSync(transcriptFile)) {
          totalTokens = await calculateTokensFromTranscript(transcriptFile);
          break;
        }
      }
    }
  }

  return {
    model: data.model?.display_name || 'Unknown',
    currentDir: path.basename(cwd),
    git: getGitInfo(cwd),
    totalTokens,
    rateLimits: data.rate_limits || null,
    version: getClaudeVersion(),
  };
}

// ==== Rendering ====

function render(ctx) {
  const nowEpoch = Math.floor(Date.now() / 1000);

  const pct = Math.min(100, Math.round((ctx.totalTokens / COMPACTION_THRESHOLD) * 100));
  const branchDisplay = ctx.git.branchName ? ` (${ctx.git.branchName}${ctx.git.isDirty ? '*' : ''})` : '';
  const line1 = `${ctx.currentDir}${branchDisplay} · ${colorByPct(pct)}${pct}%${COLORS.RESET} (${formatTokenCount(ctx.totalTokens)})`;

  const RATE_LIMIT_KEYS = [
    { key: 'five_hour', label: '5h' },
    { key: 'seven_day', label: '7d' },
  ];

  const usageParts = RATE_LIMIT_KEYS
    .filter(({ key }) => ctx.rateLimits?.[key])
    .map(({ key, label }) => {
      const u = Math.round(ctx.rateLimits[key].used_percentage);
      let part = `${label} ${colorByUsage(u)}${u}%${COLORS.RESET}`;
      if (ctx.rateLimits[key].resets_at) part += ` (${formatDuration(ctx.rateLimits[key].resets_at - nowEpoch)})`;
      return part;
    });

  const line2Parts = [`${ctx.model} v${ctx.version}`];
  if (usageParts.length) line2Parts.push(usageParts.join(' · '));

  return `${line1}\n${line2Parts.join(' · ')}`;
}

// ==== Main ====

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const ctx = await collectData(input);
    console.log(render(ctx));
  } catch {
    console.log('[Error] . | 0 | 0%');
  }
});
