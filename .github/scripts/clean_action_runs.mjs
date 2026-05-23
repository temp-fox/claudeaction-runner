#!/usr/bin/env node

const API_ROOT = 'https://api.github.com';
const RUNNING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

class GitHubRequestError extends Error {
  constructor(message, { status, method, path }) {
    super(message);
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || '',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--repo') args.repo = argv[++index] || '';
    else if (item === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数：${item}`);
  }
  args.repo = String(args.repo || '').trim();
  if (!/^[^/]+\/[^/]+$/.test(args.repo)) throw new Error('缺少有效仓库名，请设置 GITHUB_REPOSITORY 或传入 --repo owner/name');
  return args;
}

function token() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

async function githubRequest(path, { method = 'GET' } = {}) {
  const authToken = token();
  if (!authToken) throw new Error('缺少 GH_TOKEN 或 GITHUB_TOKEN');
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${authToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.message || response.statusText;
    throw new GitHubRequestError(`${method} ${path} 失败：${response.status} ${message}`, {
      status: response.status,
      method,
      path,
    });
  }
  return body;
}

async function listRuns(repo) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const data = await githubRequest(`/repos/${repo}/actions/runs?per_page=100&page=${page}`);
    const items = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    runs.push(...items);
    if (items.length < 100) break;
  }
  return runs;
}

function classifyRun(run) {
  const currentRunId = String(process.env.GITHUB_RUN_ID || '');
  if (String(run.id) === currentRunId) return 'current';
  if (RUNNING_STATUSES.has(String(run.status || ''))) return 'active';
  if (run.status !== 'completed') return 'not-completed';
  return 'delete';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = await listRuns(args.repo);
  const stats = { total: runs.length, deleted: 0, failed: 0, candidates: 0, skipped_current: 0, skipped_active: 0, skipped_other: 0 };

  for (const run of runs) {
    const reason = classifyRun(run);
    const label = `#${run.run_number} ${run.name || run.workflow_id} id=${run.id} status=${run.status} conclusion=${run.conclusion || ''}`;
    if (reason === 'current') {
      stats.skipped_current += 1;
      console.log(`[skip:current] ${label}`);
      continue;
    }
    if (reason === 'active') {
      stats.skipped_active += 1;
      console.log(`[skip:active] ${label}`);
      continue;
    }
    if (reason !== 'delete') {
      stats.skipped_other += 1;
      console.log(`[skip:${reason}] ${label}`);
      continue;
    }

    stats.candidates += 1;
    if (args.dryRun) {
      console.log(`[dry-run:delete] ${label}`);
      continue;
    }
    try {
      await githubRequest(`/repos/${args.repo}/actions/runs/${run.id}`, { method: 'DELETE' });
      stats.deleted += 1;
      console.log(`[deleted] ${label}`);
    } catch (error) {
      stats.failed += 1;
      console.log(`[delete-failed] ${label} reason=${error?.message || String(error)}`);
      if (error instanceof GitHubRequestError && [401, 403].includes(error.status)) {
        console.log(`[stop] GitHub token can no longer delete action runs; keeping remaining runs for next cleanup.`);
        break;
      }
    }
  }

  console.log(JSON.stringify({ ok: true, repo: args.repo, dry_run: args.dryRun, ...stats }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
