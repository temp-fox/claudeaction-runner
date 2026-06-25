import { Buffer } from 'node:buffer';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = process.env.GITHUB_WORKSPACE;
const runnerTemp = process.env.RUNNER_TEMP;
const eventPath = process.env.GITHUB_EVENT_PATH;
const privateDir = join(runnerTemp, 'private-repo');
const tempLogDir = join(runnerTemp, 'private-claudeaction-logs');
const DEFAULT_RUNNER_TOTAL_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROCESS_KILL_GRACE_SECONDS = 30;
const SPARSE_CHECKOUT_DIRS = ['.claude', '.github', 'docs', 'references', 'scripts', 'site', 'state', 'tests'];
const RESULT_PATH_PREFIXES = ['articles/', 'logs/', 'outputs/', 'state/', 'site/data/'];
const RESULT_PATHS = new Set(['state', 'site/data/articles.json', 'site/data/batch-status.json']);
const GIT_ADD_BATCH_SIZE = 100;
const LOG_MAX_CHARS = 2 * 1024 * 1024;
const DEFERRED_LOG_MAX_CHARS = 1024 * 1024;
const deferredLogs = [];

class RunnerError extends Error {
  constructor(stage) {
    super(stage);
    this.stage = stage;
  }
}

class RunnerTimeoutError extends RunnerError {
  constructor(stage, timeoutMs) {
    super(stage);
    this.timeoutMs = timeoutMs;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function positiveIntValue(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runnerTotalTimeoutMs() {
  return positiveIntValue(process.env.RUNNER_TOTAL_TIMEOUT_MS, DEFAULT_RUNNER_TOTAL_TIMEOUT_MS);
}

function remainingMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

function timeoutCommand(args, timeoutMs) {
  if (process.platform === 'win32') return args;
  return ['timeout', `--kill-after=${PROCESS_KILL_GRACE_SECONDS}s`, `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, ...args];
}

function isTimeoutResult(completed) {
  return completed.status === 124
    || completed.status === 137
    || completed.signal === 'SIGTERM'
    || completed.signal === 'SIGKILL'
    || completed.error?.code === 'ETIMEDOUT';
}

function textProvidersJson() {
  return process.env.CLAUDE_PROVIDERS_JSON || process.env.CLAUDE_ACTION_PROVIDERS_JSON || '';
}

function providerSecretValues() {
  const values = [process.env.IMAGE_PROVIDER_API_KEY].filter(Boolean).map(String);
  for (const envName of ['CLAUDE_PROVIDERS_JSON', 'CLAUDE_ACTION_PROVIDERS_JSON', 'IMAGE_PROVIDERS_JSON']) {
    try {
      const parsed = JSON.parse(process.env[envName] || '[]');
      if (!Array.isArray(parsed)) continue;
      values.push(...parsed.flatMap((provider) => {
        if (!provider || typeof provider !== 'object') return [];
        return [provider.api_key, provider.apiKey, provider.key].filter(Boolean).map(String);
      }));
    } catch {
    }
  }
  return values;
}

function secretValues(extra = []) {
  return [
    process.env.PRIVATE_REPO_TOKEN || '',
    process.env.CLAUDE_PROVIDERS_JSON || '',
    process.env.CLAUDE_ACTION_PROVIDERS_JSON || '',
    ...providerSecretValues(),
    ...extra,
  ].filter(Boolean);
}

function sanitize(text, secrets = secretValues()) {
  let result = String(text || '');
  for (const secret of secrets) result = result.split(secret).join('***');
  return result;
}

function truncateLogContent(content, maxChars = LOG_MAX_CHARS) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;
  return [
    `--- log truncated; kept last ${maxChars} chars of ${text.length} chars ---`,
    text.slice(-maxChars),
  ].join('\n');
}

function rememberDeferredLog(name, content, secrets = secretValues()) {
  deferredLogs.push({
    name,
    content: sanitize(truncateLogContent(content, DEFERRED_LOG_MAX_CHARS), secrets),
  });
}

function flushDeferredLogs(secrets = secretValues()) {
  if (!deferredLogs.length) return;
  mkdirSync(tempLogDir, { recursive: true });
  while (deferredLogs.length) {
    const log = deferredLogs.shift();
    writeFileSync(join(tempLogDir, `deferred-${log.name}`), sanitize(log.content, secrets), 'utf8');
  }
}

function writeLog(name, content, secrets = secretValues()) {
  try {
    mkdirSync(tempLogDir, { recursive: true });
    writeFileSync(join(tempLogDir, name), sanitize(truncateLogContent(content), secrets), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOSPC') throw error;
    rememberDeferredLog(name, content, secrets);
    console.log(`[runner] deferred log ${name}: no space left on device`);
  }
}

function writeJsonLog(name, payload, secrets = secretValues()) {
  writeLog(name, JSON.stringify(payload, null, 2), secrets);
}

function diskUsageScript(label) {
  return [
    `echo "label=${label}"`,
    'echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    'echo "--- df -h ---"',
    'df -h',
    'echo "--- workspace du ---"',
    'du -h -d 2 "$GITHUB_WORKSPACE" 2>/dev/null | sort -h | tail -80 || true',
    'echo "--- runner temp du ---"',
    'du -h -d 2 "$RUNNER_TEMP" 2>/dev/null | sort -h | tail -80 || true',
    'if [ -d "$RUNNER_TEMP/private-repo" ]; then echo "--- private repo du ---"; du -h -d 2 "$RUNNER_TEMP/private-repo" 2>/dev/null | sort -h | tail -120 || true; fi',
  ].join('\n');
}

function recordDiskUsage(label, secrets = secretValues()) {
  const completed = spawnSync('bash', ['-lc', diskUsageScript(label)], {
    cwd: workspace,
    env: { ...process.env },
    encoding: 'utf8',
  });
  writeLog(`disk-${label}.log`, [
    `label=${label}`,
    `exit_code=${completed.status}`,
    `signal=${completed.signal || ''}`,
    '--- stdout ---',
    completed.stdout || '',
    '--- stderr ---',
    completed.stderr || '',
  ].join('\n'), secrets);
}

function runStage(stage, args, { cwd = workspace, env = {}, secrets = secretValues(), timeoutMs = null } = {}) {
  const startedAt = nowIso();
  const boundedArgs = timeoutMs ? timeoutCommand(args, timeoutMs) : args;
  const completed = spawnSync(boundedArgs[0], boundedArgs.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs ? timeoutMs + PROCESS_KILL_GRACE_SECONDS * 1000 + 5000 : undefined,
  });
  completed.runnerTimedOut = Boolean(timeoutMs && isTimeoutResult(completed));
  completed.runnerTimeoutMs = timeoutMs || null;
  writeLog(`${stage}.log`, [
    `stage=${stage}`,
    `cwd=${cwd}`,
    `command=${JSON.stringify(args)}`,
    `bounded_command=${JSON.stringify(boundedArgs)}`,
    `timeout_ms=${timeoutMs || ''}`,
    `runner_timed_out=${completed.runnerTimedOut}`,
    `exit_code=${completed.status}`,
    `signal=${completed.signal || ''}`,
    `started_at=${startedAt}`,
    `completed_at=${nowIso()}`,
    `env_override_keys=${JSON.stringify(Object.keys(env).sort())}`,
    `stdout_chars=${(completed.stdout || '').length}`,
    `stderr_chars=${(completed.stderr || '').length}`,
    '--- stdout ---',
    completed.stdout || '',
    '--- stderr ---',
    completed.stderr || '',
  ].join('\n'), secrets);
  if (completed.error) writeLog(`${stage}-error.log`, String(completed.error), secrets);
  return completed;
}

function requireSuccess(completed, stage) {
  if (completed.runnerTimedOut) throw new RunnerTimeoutError(stage, completed.runnerTimeoutMs);
  if (completed.status !== 0) throw new RunnerError(stage);
}

function payload() {
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const data = event.client_payload || {};
  const privateRepository = String(data.private_repository || '').trim();
  const privateRef = String(data.private_ref || 'main').trim() || 'main';
  const finalPrompt = String(data.final_prompt || '').trim();
  const contentSkillRunsJson = String(data.content_skill_runs_json || '').trim();
  const upstreamRunId = String(data.upstream_run_id || '').trim();
  if (!privateRepository || !privateRepository.includes('/')) throw new RunnerError('resolve-payload');
  return { privateRepository, privateRef, finalPrompt, contentSkillRunsJson, upstreamRunId };
}

function maskKnownSecrets(privateRepository) {
  for (const value of [
    process.env.PRIVATE_REPO_TOKEN || '',
    privateRepository,
    ...providerSecretValues(),
  ].filter(Boolean)) {
    console.log(`::add-mask::${value}`);
  }
}

function checkoutPrivate(data) {
  const token = process.env.PRIVATE_REPO_TOKEN || '';
  if (!token) throw new RunnerError('checkout-private');
  const repoUrl = `https://x-access-token:${token}@github.com/${data.privateRepository}.git`;
  const secrets = secretValues([repoUrl, data.privateRepository]);
  requireSuccess(runStage('clone-private-metadata', [
    'git', 'clone', '--quiet', '--filter=blob:none', '--depth=1', '--no-checkout', '--branch', data.privateRef, repoUrl, privateDir,
  ], { secrets }), 'clone-private-metadata');
  requireSuccess(runStage('sparse-checkout-init', ['git', 'sparse-checkout', 'init', '--cone'], { cwd: privateDir, secrets }), 'sparse-checkout-init');
  requireSuccess(runStage('sparse-checkout-set', ['git', 'sparse-checkout', 'set', ...SPARSE_CHECKOUT_DIRS], { cwd: privateDir, secrets }), 'sparse-checkout-set');
  requireSuccess(runStage('checkout-private', ['git', 'checkout', '--quiet', data.privateRef], { cwd: privateDir, secrets }), 'checkout-private');
  requireSuccess(runStage('set-private-origin', ['git', 'remote', 'set-url', 'origin', repoUrl], { cwd: privateDir, secrets }), 'set-private-origin');
}

function installClaudeCli() {
  const script = 'CLAUDE_CODE_VERSION="2.1.145"; curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"';
  requireSuccess(runStage('install-claude-cli', ['bash', '-lc', script]), 'install-claude-cli');
}

function runPrivateClaude(data, timeoutMs) {
  const providersJson = textProvidersJson();
  if (!providersJson) throw new RunnerError('missing-provider-json');
  if (timeoutMs <= 0) throw new RunnerTimeoutError('runner-total-timeout-before-private-claude', runnerTotalTimeoutMs());
  const env = {
    CLAUDE_BIN: `${process.env.HOME}/.local/bin/claude`,
    CLAUDE_PROVIDERS_JSON: providersJson,
    CLAUDE_ACTION_PROVIDERS_JSON: providersJson,
    CONTENT_SKILL_RUNS_JSON: data.contentSkillRunsJson,
    FINAL_PROMPT: data.finalPrompt,
    CLAUDE_ACTION_ALLOWED_TOOLS: 'Read,Glob,Grep,Edit,Write,Bash(pwd),Bash(ls),Bash(git status --short),Bash(git diff),Bash(git log --oneline:*),Bash(python -m json.tool:*)',
    CLAUDE_ACTION_STREAM_JSON_LOGS: 'true',
    CLAUDE_ACTION_DISABLE_STEP_SUMMARY: 'true',
    CLAUDE_ACTION_POSTPROCESS: process.env.CLAUDE_ACTION_POSTPROCESS || 'true',
    CLAUDE_ACTION_POSTPROCESS_STRICT: process.env.CLAUDE_ACTION_POSTPROCESS_STRICT || 'false',
    IMAGE_GENERATION_ENABLED: process.env.IMAGE_GENERATION_ENABLED || '',
    IMAGE_PROVIDERS_JSON: process.env.IMAGE_PROVIDERS_JSON || '',
    IMAGE_PROVIDER_BASE_URL: process.env.IMAGE_PROVIDER_BASE_URL || '',
    IMAGE_PROVIDER_API_KEY: process.env.IMAGE_PROVIDER_API_KEY || '',
    IMAGE_PROVIDER_MODEL: process.env.IMAGE_PROVIDER_MODEL || '',
    IMAGE_PROVIDER_TIMEOUT_SECONDS: process.env.IMAGE_PROVIDER_TIMEOUT_SECONDS || '',
    IMAGE_PROVIDER_ASYNC_MODE: process.env.IMAGE_PROVIDER_ASYNC_MODE || '',
    IMAGE_PROVIDER_ASYNC_POLL_INTERVAL_SECONDS: process.env.IMAGE_PROVIDER_ASYNC_POLL_INTERVAL_SECONDS || '',
    IMAGE_MAX_IMAGES_PER_ARTICLE: process.env.IMAGE_MAX_IMAGES_PER_ARTICLE || '',
    IMAGE_MAX_PARALLELISM: process.env.IMAGE_MAX_PARALLELISM || '',
    IMAGE_RESPONSE_FORMAT: process.env.IMAGE_RESPONSE_FORMAT || '',
    IMAGE_STRICT: process.env.IMAGE_STRICT || '',
    SITE_WINDOW_DAYS: process.env.SITE_WINDOW_DAYS || '',
    ARTICLE_IMAGE_BASE_URL: process.env.ARTICLE_IMAGE_BASE_URL || '',
    POSTPROCESS_STRICT: process.env.POSTPROCESS_STRICT || '',
    POSTPROCESS_SKIP_EXISTING: process.env.POSTPROCESS_SKIP_EXISTING || '',
    RUNNER_TOTAL_TIMEOUT_MS: String(runnerTotalTimeoutMs()),
    RUNNER_PRIVATE_STAGE_TIMEOUT_MS: String(timeoutMs),
  };
  requireSuccess(runStage('run-private-claude-sequence', ['node', 'scripts/run_claude_sequence.mjs'], { cwd: privateDir, env, timeoutMs }), 'run-private-claude-sequence');
}

function copyTempLogsToPrivateTarget(target) {
  if (!existsSync(tempLogDir)) return;
  for (const name of readdirSync(tempLogDir)) {
    try {
      copyFileSync(join(tempLogDir, name), join(target, name));
    } catch (error) {
      if (error?.code !== 'ENOSPC') throw error;
      rememberDeferredLog(`copy-${name}.log`, error?.stack || String(error));
      console.log(`[runner] deferred copied log ${name}: no space left on device`);
    }
  }
}

function tempLogEntries(secrets = secretValues()) {
  const entries = [];
  if (existsSync(tempLogDir)) {
    for (const name of readdirSync(tempLogDir)) {
      try {
        entries.push({ name, content: sanitize(readFileSync(join(tempLogDir, name), 'utf8'), secrets) });
      } catch (error) {
        entries.push({ name: `read-${name}-error.log`, content: sanitize(error?.stack || String(error), secrets) });
      }
    }
  }
  for (const log of deferredLogs) entries.push({ name: `deferred-${log.name}`, content: sanitize(log.content, secrets) });
  return entries;
}

async function putPrivateLogFile(data, runDir, name, content, secrets) {
  const token = process.env.PRIVATE_REPO_TOKEN || '';
  if (!token) throw new RunnerError('github-api-log-token');
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '-');
  const response = await fetch(`https://api.github.com/repos/${data.privateRepository}/contents/${runDir}/${safeName}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `chore: record runner fallback log ${process.env.GITHUB_RUN_ID || 'unknown'}`,
      content: Buffer.from(sanitize(content, secrets)).toString('base64'),
      branch: data.privateRef,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub log API failed ${response.status}: ${sanitize(body, secrets)}`);
  }
}

async function pushPrivateLogsViaApi(data, status, failedStage, cause) {
  const secrets = secretValues([data.privateRepository]);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runId = process.env.GITHUB_RUN_ID || 'unknown';
  const runDir = `logs/runner/${timestamp}-${runId}`;
  const summary = {
    status,
    failed_stage: failedStage,
    public_runner_run_id: runId,
    upstream_private_run_id: data.upstreamRunId,
    private_ref: data.privateRef,
    recorded_at: nowIso(),
    fallback: 'github-contents-api',
    fallback_cause: cause?.stack || String(cause || ''),
  };
  await putPrivateLogFile(data, runDir, 'summary.json', JSON.stringify(summary, null, 2), secrets);
  await putPrivateLogFile(data, runDir, 'runner-summary.log', JSON.stringify(summary, null, 2), secrets);
  const entries = tempLogEntries(secrets);
  for (const entry of entries) await putPrivateLogFile(data, runDir, entry.name, entry.content, secrets);
}

function cleanupFailureArtifacts() {
  if (!existsSync(privateDir)) return;
  const removed = [];
  for (const candidate of ['articles', 'outputs']) {
    const target = join(privateDir, candidate);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(candidate);
  }
  writeJsonLog('failure-artifact-cleanup.log', {
    removed,
    note: '失败路径优先确保 runner 日志能写回 logs；本次生成的大产物不会在失败提交中保留',
    recorded_at: nowIso(),
  });
}

function gitAddPaths(paths, secrets) {
  for (let index = 0; index < paths.length; index += GIT_ADD_BATCH_SIZE) {
    const batch = paths.slice(index, index + GIT_ADD_BATCH_SIZE);
    requireSuccess(runStage(`git-add-results-${index / GIT_ADD_BATCH_SIZE + 1}`, ['git', 'add', '--sparse', '-f', ...batch], { cwd: privateDir, secrets }), 'git-add-results');
  }
}

function resultPathsToAdd(status) {
  if (status !== 'success') return ['logs'];
  const statusResult = runStage('git-status-results', ['git', 'status', '--porcelain', '--untracked-files=all', '--', ...Array.from(new Set([...RESULT_PATH_PREFIXES, ...RESULT_PATHS]))], { cwd: privateDir });
  if (statusResult.status !== 0) throw new RunnerError('git-status-results');
  const paths = new Set(['logs']);
  for (const line of String(statusResult.stdout || '').split('\n')) {
    const path = line.slice(3).trim();
    if (!path) continue;
    if (RESULT_PATHS.has(path) || RESULT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) paths.add(path);
  }
  return Array.from(paths).sort();
}

function copyRunnerLogsToPrivate(data, status, failedStage) {
  if (!existsSync(privateDir)) return null;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runId = process.env.GITHUB_RUN_ID || 'unknown';
  const target = join(privateDir, 'logs', 'runner', `${timestamp}-${runId}`);
  flushDeferredLogs(secretValues([data.privateRepository]));
  mkdirSync(target, { recursive: true });
  writeJsonLog('runner-summary.log', {
    status,
    failed_stage: failedStage,
    public_runner_run_id: runId,
    upstream_private_run_id: data.upstreamRunId,
    private_ref: data.privateRef,
    recorded_at: nowIso(),
  }, secretValues([data.privateRepository]));
  flushDeferredLogs(secretValues([data.privateRepository]));
  copyTempLogsToPrivateTarget(target);
  copyFileSync(join(tempLogDir, 'runner-summary.log'), join(target, 'summary.json'));
  return target;
}

function pushPrivateLogs(data, status, failedStage) {
  if (status !== 'success') cleanupFailureArtifacts();
  const logDir = copyRunnerLogsToPrivate(data, status, failedStage);
  if (!logDir) return;
  const secrets = secretValues([data.privateRepository]);
  requireSuccess(runStage('git-config-name', ['git', 'config', 'user.name', 'github-actions[bot]'], { cwd: privateDir, secrets }), 'git-config-name');
  requireSuccess(runStage('git-config-email', ['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: privateDir, secrets }), 'git-config-email');
  gitAddPaths(resultPathsToAdd(status), secrets);
  const diff = runStage('git-diff-cached', ['git', 'diff', '--cached', '--quiet'], { cwd: privateDir, secrets });
  if (diff.status === 0) return;
  if (diff.status !== 1) throw new RunnerError('git-diff-cached');
  const messageStatus = status === 'success' ? 'completed' : `failed at ${failedStage}`;
  requireSuccess(runStage('git-commit-logs', ['git', 'commit', '-m', `chore: record runner claudeaction ${messageStatus}`], { cwd: privateDir, secrets }), 'git-commit-logs');
  requireSuccess(runStage('git-pull', ['git', 'pull', '--rebase', '--autostash', 'origin', data.privateRef], { cwd: privateDir, secrets }), 'git-pull');
  requireSuccess(runStage('git-push-logs', ['git', 'push', 'origin', `HEAD:${data.privateRef}`], { cwd: privateDir, secrets }), 'git-push-logs');
}

async function main() {
  mkdirSync(tempLogDir, { recursive: true });
  const totalTimeoutMs = runnerTotalTimeoutMs();
  const deadlineMs = Date.now() + totalTimeoutMs;
  let data = null;
  let status = 'success';
  let failedStage = null;
  try {
    console.log(`[runner] start; total timeout ${Math.round(totalTimeoutMs / 60000)}min`);
    data = payload();
    maskKnownSecrets(data.privateRepository);
    writeJsonLog('payload-summary.log', {
      private_repository: data.privateRepository,
      private_ref: data.privateRef,
      has_final_prompt: Boolean(data.finalPrompt),
      has_content_skill_runs_json: Boolean(data.contentSkillRunsJson),
      upstream_run_id: data.upstreamRunId,
      total_timeout_ms: totalTimeoutMs,
      deadline_at: new Date(deadlineMs).toISOString(),
      started_at: nowIso(),
    }, secretValues([data.privateRepository]));
    recordDiskUsage('start', secretValues([data.privateRepository]));
    checkoutPrivate(data);
    recordDiskUsage('after-checkout-private', secretValues([data.privateRepository]));
    console.log('[runner] private workspace ready');
    installClaudeCli();
    recordDiskUsage('after-install-claude-cli', secretValues([data.privateRepository]));
    runPrivateClaude(data, remainingMs(deadlineMs));
    recordDiskUsage('after-private-claude', secretValues([data.privateRepository]));
    console.log('[runner] private claudeaction completed');
  } catch (error) {
    status = 'failure';
    if (error instanceof RunnerTimeoutError) {
      failedStage = `timeout:${error.stage}`;
      writeJsonLog('runner-timeout.log', {
        failed_stage: error.stage,
        timeout_ms: error.timeoutMs,
        total_timeout_ms: totalTimeoutMs,
        deadline_at: new Date(deadlineMs).toISOString(),
        recorded_at: nowIso(),
        note: '运行触及 runner 总超时上限，已主动终止子进程；本次日志仍会被推送，可据此定位卡在哪个阶段',
      }, data ? secretValues([data.privateRepository]) : secretValues());
    } else {
      failedStage = error instanceof RunnerError ? error.stage : error?.name || 'unexpected-error';
    }
    writeLog('runner-error.log', error?.stack || String(error), data ? secretValues([data.privateRepository]) : secretValues());
    if (data) recordDiskUsage('on-error', secretValues([data.privateRepository]));
    console.log('[runner] failed; details are recorded in private logs');
  }

  try {
    if (data) {
      pushPrivateLogs(data, status, failedStage);
      console.log('[runner] private logs recorded');
    }
  } catch (error) {
    writeLog('push-private-logs-error.log', error?.stack || String(error), data ? secretValues([data.privateRepository]) : secretValues());
    console.log('[runner] failed to record private logs via git; trying GitHub contents API fallback');
    if (data) {
      try {
        await pushPrivateLogsViaApi(data, status, failedStage, error);
        console.log('[runner] private logs recorded via GitHub contents API fallback');
      } catch (fallbackError) {
        console.log('[runner] failed to record private logs via fallback');
        console.log(sanitize(fallbackError?.stack || String(fallbackError), secretValues([data.privateRepository])));
        process.exitCode = 1;
        return;
      }
    } else {
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = status === 'success' ? 0 : 1;
}

main().catch((error) => {
  console.log('[runner] unexpected top-level failure');
  console.log(sanitize(error?.stack || String(error)));
  process.exitCode = 1;
});
