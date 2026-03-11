#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

// Constants
const COMPACTION_THRESHOLD = 200000 * 0.8;
const USAGE_CACHE_FILE = path.join(process.env.HOME, '.claude', 'usage-cache.json');
const USAGE_CACHE_TTL = 60000; // 1 minute
const COLORS = { GREEN: '\x1b[32m', YELLOW: '\x1b[33m', RED: '\x1b[31m', RESET: '\x1b[0m' };
const MS_PER_MINUTE = 60000;
const MINUTES_PER_DAY = 1440;

// Read JSON from stdin
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    // Extract values
    const cwd = data.workspace?.current_dir || data.cwd || '.';
    const model = data.model?.display_name || 'Unknown';
    const currentDir = path.basename(cwd);
    const sessionId = data.session_id;

    // Get git branch name and dirty state
    const { branchName, isDirty } = getGitInfo(cwd);

    // Calculate token usage for current session
    let totalTokens = 0;

    if (sessionId) {
      // Find all transcript files
      const projectsDir = path.join(process.env.HOME, '.claude', 'projects');

      if (fs.existsSync(projectsDir)) {
        // Get all project directories
        const projectDirs = fs.readdirSync(projectsDir)
          .map(dir => path.join(projectsDir, dir))
          .filter(dir => fs.statSync(dir).isDirectory());

        // Search for the current session's transcript file
        for (const projectDir of projectDirs) {
          const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);

          if (fs.existsSync(transcriptFile)) {
            totalTokens = await calculateTokensFromTranscript(transcriptFile);
            break;
          }
        }
      }
    }

    // Calculate percentage
    const percentage = Math.min(100, Math.round((totalTokens / COMPACTION_THRESHOLD) * 100));

    // Format token display
    const tokenDisplay = formatTokenCount(totalTokens);

    // Color coding for percentage
    const percentageColor = percentage >= 90 ? COLORS.RED : percentage >= 70 ? COLORS.YELLOW : COLORS.GREEN;

    // Fetch usage limits
    const usage = await getUsageLimits();
    const usageDisplay = formatUsageDisplay(usage);

    // Build status line
    const branchDisplay = branchName ? ` (${branchName}${isDirty ? '*' : ''})` : '';
    const line1 = `${currentDir}${branchDisplay} · ${percentageColor}${percentage}%${COLORS.RESET} (${tokenDisplay})`;
    const modelPart = `${model} v${CLAUDE_VERSION}`;
    const line2 = [modelPart, usageDisplay].filter(Boolean).join(' · ');

    console.log(`${line1}\n${line2}`);
  } catch (error) {
    // Fallback status line on error
    console.log('[Error] 📁 . | 🪙 0 | 0%');
  }
});

function getGitInfo(cwd) {
  try {
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const status = execSync('git status --porcelain', { cwd, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return { branchName, isDirty: status.length > 0 };
  } catch (e) {
    return { branchName: '', isDirty: false };
  }
}

async function calculateTokensFromTranscript(filePath) {
  return new Promise((resolve, reject) => {
    let lastUsage = null;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      try {
        const entry = JSON.parse(line);

        // Check if this is an assistant message with usage data
        if (entry.type === 'assistant' && entry.message?.usage) {
          lastUsage = entry.message.usage;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    });

    rl.on('close', () => {
      if (lastUsage) {
        // The last usage entry contains cumulative tokens
        const totalTokens = (lastUsage.input_tokens || 0) +
          (lastUsage.output_tokens || 0) +
          (lastUsage.cache_creation_input_tokens || 0) +
          (lastUsage.cache_read_input_tokens || 0);
        resolve(totalTokens);
      } else {
        resolve(0);
      }
    });

    rl.on('error', (err) => {
      reject(err);
    });
  });
}

function getOAuthToken() {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    const creds = JSON.parse(raw);
    return creds.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

const CLAUDE_VERSION = (() => {
  try {
    return execSync('claude --version', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split(/\s+/)[0] || '2.1.0';
  } catch {
    return '2.1.0';
  }
})();

async function fetchUsageFromAPI() {
  const token = getOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${CLAUDE_VERSION}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getUsageLimits() {
  let cache = null;

  // Check cache
  try {
    if (fs.existsSync(USAGE_CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
      if (Date.now() - cache.timestamp < USAGE_CACHE_TTL) {
        return cache.data;
      }
    }
  } catch {}

  // Fetch fresh data
  const data = await fetchUsageFromAPI();
  if (data) {
    try {
      fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }));
    } catch {}
    return data;
  }

  // API failed (429 etc.) → write cache to prevent hammering API
  try {
    const fallbackData = cache?.data || null;
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data: fallbackData }));
    return fallbackData;
  } catch {}

  return null;
}

function formatResetTime(resetStr) {
  if (!resetStr) return '';
  const reset = new Date(resetStr);
  const now = new Date();
  const diffMs = reset - now;
  if (diffMs <= 0) return 'now';
  const diffMin = Math.floor(diffMs / MS_PER_MINUTE);
  const days = Math.floor(diffMin / MINUTES_PER_DAY);
  const hours = Math.floor((diffMin % MINUTES_PER_DAY) / 60);
  const mins = diffMin % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function usageColor(utilization) {
  if (utilization >= 80) return COLORS.RED;
  if (utilization >= 50) return COLORS.YELLOW;
  return COLORS.GREEN;
}

function formatUsageDisplay(usage) {
  if (!usage) return '';

  const parts = [];
  if (usage.five_hour) {
    const u = Math.round(usage.five_hour.utilization);
    const c = usageColor(u);
    const reset = formatResetTime(usage.five_hour.resets_at);
    parts.push(`5h ${c}${u}%${COLORS.RESET} (${reset})`);
  }
  if (usage.seven_day) {
    const u = Math.round(usage.seven_day.utilization);
    const c = usageColor(u);
    const reset = formatResetTime(usage.seven_day.resets_at);
    parts.push(`7d ${c}${u}%${COLORS.RESET} (${reset})`);
  }
  return parts.length > 0 ? parts.join(' · ') : '';
}


function formatTokenCount(tokens) {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}