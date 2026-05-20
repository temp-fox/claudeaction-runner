import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = process.env.GITHUB_WORKSPACE;
const runnerTemp = process.env.RUNNER_TEMP;
const eventPath = process.env.GITHUB_EVENT_PATH;
const privateDir = join(workspace, 'private-repo');
const tempLogDir = join(runnerTemp, 'private-claudeaction-logs');

class RunnerError extends Error {
  constructor(stage) {
    super(stage);
    this.stage = stage;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function providerSecretValues() {
  try {
    const parsed = JSON.parse(process.env.CLAUDE_ACTION_PROVIDERS_JSON || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((provider) => {
      if (!provider || typeof provider !== 'object') return [];
      return [provider.api_key, provider.key].filter(Boolean).map(String);
    });
  } catch {
    return [];
  }
}

function secretValues(extra = []) {
  return [
    process.env.PRIVATE_REPO_TOKEN || '',
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

function writeLog(name, content, secrets = secretValues()) {
  mkdirSync(tempLogDir, { recursive: true });
  writeFileSync(join(tempLogDir, name), sanitize(content, secrets), 'utf8');
}

function writeJsonLog(name, payload, secrets = secretValues()) {
  writeLog(name, JSON.stringify(payload, null, 2), secrets);
}

function runStage(stage, args, { cwd = workspace, env = {}, secrets = secretValues() } = {}) {
  const startedAt = nowIso();
  const completed = spawnSync(args[0], args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: Number.parseInt(process.env.RUNNER_STAGE_TIMEOUT_MS || '1800000', 10),
  });
  writeLog(`${stage}.log`, [
    `stage=${stage}`,
    `cwd=${cwd}`,
    `command=${JSON.stringify(args)}`,
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
  requireSuccess(runStage('checkout-private', ['git', 'clone', '--quiet', '--branch', data.privateRef, repoUrl, privateDir], { secrets }), 'checkout-private');
  requireSuccess(runStage('set-private-origin', ['git', 'remote', 'set-url', 'origin', repoUrl], { cwd: privateDir, secrets }), 'set-private-origin');
}

function installClaudeCli() {
  const script = 'CLAUDE_CODE_VERSION="2.1.145"; curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"';
  requireSuccess(runStage('install-claude-cli', ['bash', '-lc', script]), 'install-claude-cli');
}

function runPrivateClaude(data) {
  if (!process.env.CLAUDE_ACTION_PROVIDERS_JSON) throw new RunnerError('missing-provider-json');
  const env = {
    CLAUDE_BIN: `${process.env.HOME}/.local/bin/claude`,
    CLAUDE_ACTION_PROVIDERS_JSON: process.env.CLAUDE_ACTION_PROVIDERS_JSON,
    CONTENT_SKILL_RUNS_JSON: data.contentSkillRunsJson,
    FINAL_PROMPT: data.finalPrompt,
    CLAUDE_ACTION_PROBE_TIMEOUT_MS: process.env.CLAUDE_ACTION_PROBE_TIMEOUT_MS || '180000',
    CLAUDE_ACTION_FINAL_TIMEOUT_MS: process.env.CLAUDE_ACTION_FINAL_TIMEOUT_MS || '900000',
    CLAUDE_ACTION_ALLOWED_TOOLS: 'Read,Glob,Grep,Edit,Write,Bash(pwd),Bash(ls),Bash(git status --short),Bash(git diff),Bash(git log --oneline:*),Bash(python -m json.tool:*)',
    CLAUDE_ACTION_DISABLE_STEP_SUMMARY: 'true',
  };
  requireSuccess(runStage('run-private-claude-sequence', ['node', 'scripts/run_claude_sequence.mjs'], { cwd: privateDir, env }), 'run-private-claude-sequence');
}

function copyRunnerLogsToPrivate(data, status, failedStage) {
  if (!existsSync(privateDir)) return null;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runId = process.env.GITHUB_RUN_ID || 'unknown';
  const target = join(privateDir, 'logs', 'runner', `${timestamp}-${runId}`);
  mkdirSync(target, { recursive: true });
  if (existsSync(tempLogDir)) {
    for (const name of readdirSync(tempLogDir)) {
      if (name.endsWith('.log')) copyFileSync(join(tempLogDir, name), join(target, name));
    }
  }
  writeJsonLog('runner-summary.log', {
    status,
    failed_stage: failedStage,
    public_runner_run_id: runId,
    upstream_private_run_id: data.upstreamRunId,
    private_ref: data.privateRef,
    recorded_at: nowIso(),
  }, secretValues([data.privateRepository]));
  copyFileSync(join(tempLogDir, 'runner-summary.log'), join(target, 'summary.json'));
  return target;
}

function pushPrivateLogs(data, status, failedStage) {
  const logDir = copyRunnerLogsToPrivate(data, status, failedStage);
  if (!logDir) return;
  const secrets = secretValues([data.privateRepository]);
  requireSuccess(runStage('git-config-name', ['git', 'config', 'user.name', 'github-actions[bot]'], { cwd: privateDir, secrets }), 'git-config-name');
  requireSuccess(runStage('git-config-email', ['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: privateDir, secrets }), 'git-config-email');
  const pathsToAdd = ['logs'];
  if (existsSync(join(privateDir, 'outputs'))) pathsToAdd.push('outputs');
  requireSuccess(runStage('git-add-results', ['git', 'add', '-f', ...pathsToAdd], { cwd: privateDir, secrets }), 'git-add-results');
  const diff = runStage('git-diff-cached', ['git', 'diff', '--cached', '--quiet'], { cwd: privateDir, secrets });
  if (diff.status === 0) return;
  if (diff.status !== 1) throw new RunnerError('git-diff-cached');
  const messageStatus = status === 'success' ? 'completed' : `failed at ${failedStage}`;
  requireSuccess(runStage('git-commit-logs', ['git', 'commit', '-m', `chore: record runner claudeaction ${messageStatus}`], { cwd: privateDir, secrets }), 'git-commit-logs');
  requireSuccess(runStage('git-pull', ['git', 'pull', '--rebase', '--autostash', 'origin', data.privateRef], { cwd: privateDir, secrets }), 'git-pull');
  requireSuccess(runStage('git-push-logs', ['git', 'push', 'origin', `HEAD:${data.privateRef}`], { cwd: privateDir, secrets }), 'git-push-logs');
}

function main() {
  mkdirSync(tempLogDir, { recursive: true });
  let data = null;
  let status = 'success';
  let failedStage = null;
  try {
    console.log('[runner] start');
    data = payload();
    maskKnownSecrets(data.privateRepository);
    writeJsonLog('payload-summary.log', {
      private_repository: data.privateRepository,
      private_ref: data.privateRef,
      has_final_prompt: Boolean(data.finalPrompt),
      has_content_skill_runs_json: Boolean(data.contentSkillRunsJson),
      upstream_run_id: data.upstreamRunId,
      started_at: nowIso(),
    }, secretValues([data.privateRepository]));
    checkoutPrivate(data);
    console.log('[runner] private workspace ready');
    installClaudeCli();
    runPrivateClaude(data);
    console.log('[runner] private claudeaction completed');
  } catch (error) {
    status = 'failure';
    failedStage = error instanceof RunnerError ? error.stage : error?.name || 'unexpected-error';
    writeLog('runner-error.log', error?.stack || String(error), data ? secretValues([data.privateRepository]) : secretValues());
    console.log(`[runner] failed; stage=${failedStage}; details will be pushed to private logs when possible`);
  }

  try {
    if (data) {
      pushPrivateLogs(data, status, failedStage);
      console.log('[runner] private logs pushed');
    }
  } catch (error) {
    writeLog('push-private-logs-error.log', error?.stack || String(error), data ? secretValues([data.privateRepository]) : secretValues());
    console.log('[runner] failed to push private logs');
    process.exitCode = 1;
    return;
  }
  process.exitCode = status === 'success' ? 0 : 1;
}

main();
