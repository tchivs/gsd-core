'use strict';

/**
 * GSD extension for Pi-compatible hosts, including Oh My Pi.
 *
 * OMP loads legacy Pi extensions through the same factory contract, but its
 * current ExtensionAPI uses command handlers and Zod-backed tool parameters.
 * This bridge exposes GSD's command-routing hub, state orientation, and the
 * advisory workflow guard without depending on Claude hook payloads.
 *
 * @param {object} pi Pi/OMP ExtensionAPI
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve the GSD engine tree (the dir holding gsd-core/ + hooks/).
// Works across dev (<root>/pi/gsd.cjs → <root>) and installed layouts.
function resolveEngineRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'gsd-core'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..');
}

const ENGINE_ROOT = resolveEngineRoot(__dirname);
const GSD_CORE = path.join(ENGINE_ROOT, 'gsd-core');

// ── curated top-level command families (gsd-tools.cjs TOP_LEVEL_USAGE) ──────
// readCmdNames() (scripts/fix-slash-commands.cjs) reads commands/, which pi
// does NOT install (it ships a single native-extension file, no shared
// commands/ dir) — it would always return []. This is a self-contained,
// hand-curated subset of the STABLE top-level families documented by
// `node gsd-core/bin/gsd-tools.cjs --help` (gsd-tools.cjs:689-705). Named +
// exported (via _internals) so a test can assert against it directly.
const PI_COMMAND_FAMILIES = Object.freeze([
  'agent', 'capability', 'check', 'commit', 'config-get', 'config-path',
  'config-set', 'effort', 'git', 'graphify', 'init', 'intel', 'learnings',
  'list-todos', 'loop', 'milestone', 'phase', 'phases', 'progress',
  'requirements', 'research-plan', 'research-store', 'resolve-granularity',
  'resolve-model', 'roadmap', 'scaffold', 'smart-entry', 'state', 'task',
  'template', 'user-story', 'validate', 'verify', 'workstream', 'worktree',
]);

/**
 * Filter PI_COMMAND_FAMILIES by prefix (startsWith). Returns null when there
 * are no matches, per pi's `AutocompleteItem[]|null` contract.
 * @param {string} prefix
 * @returns {{value: string, label: string}[] | null}
 */
function getArgumentCompletions(prefix) {
  const p = typeof prefix === 'string' ? prefix : '';
  const matches = PI_COMMAND_FAMILIES.filter((name) => name.startsWith(p));
  if (matches.length === 0) return null;
  return matches.map((value) => ({ value, label: value }));
}

/**
 * Tokenize the raw `/gsd <args>` string into { family, subcommand, args }.
 * Reuses the quote-aware whitespace tokenizer already shipped for hooks
 * (hooks/lib/git-cmd.js's `tokenize`) rather than re-implementing shell-word
 * splitting a second time. #2102 Stage 2: pi's capability descriptor no
 * longer sets `hostBehaviors.skipSharedHooksInstall` (adversarial-review
 * finding #1/#2 — pi ships NO hooks/ with that flag set, so this require was
 * dead in a real install), so the shared hooks/ bundle — including
 * hooks/lib/git-cmd.js — is installed alongside the extension for real
 * (mirrors OpenCode, whose native plugin also spawns the staged hooks/*.js
 * bundle). The require below is therefore the PRIMARY, live path in an
 * installed pi tree; the whitespace-split fallback stays as defense-in-depth
 * for a corrupted/partial install (e.g. a user who deleted hooks/lib/ by
 * hand) rather than the only-ever-taken path.
 * @param {string} rawArgs
 * @returns {{ family: string, subcommand?: string, args: string[] }}
 */
function parseGsdCommandArgs(rawArgs) {
  let tokenize;
  try {
    ({ tokenize } = require(path.join(ENGINE_ROOT, 'hooks', 'lib', 'git-cmd.js')));
  } catch {
    tokenize = (s) => String(s || '').split(/\s+/).filter(Boolean);
  }
  const tokens = tokenize(typeof rawArgs === 'string' ? rawArgs : '');
  return {
    // Empty args → dispatch gsd-tools.cjs's own --help surface (a real,
    // working, ok:true default — NOT the 'query'/'help' pairing the original
    // #1944 cut used, which is not a valid gsd-tools.cjs command).
    family: tokens[0] || '--help',
    subcommand: tokens[1],
    args: tokens.slice(2),
  };
}

/**
 * Best-effort TypeBox schema for gsd_invoke's `parameters`, falling back to a
 * plain JSON-Schema object when the `typebox` package is unavailable (it is
 * NOT a gsd-core dependency — pi's own ExtensionAPI contract expects TypeBox,
 * but nothing in this repo installs it). TypeBox schemas ARE JSON Schema, so
 * the fallback object is structurally equivalent for hosts that accept plain
 * JSON Schema; this is a best-effort shim for the flat-file extension case.
 * @returns {object}
 */
function buildGsdInvokeParameters() {
  try {
    const typebox = require('typebox');
    const Type = typebox && typebox.Type;
    if (Type) {
      return Type.Object({
        family: Type.String(),
        subcommand: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String())),
      });
    }
  } catch {
    // typebox is not installed in this environment — fall through.
  }
  process.stderr.write(
    'gsd: typebox unavailable — gsd_invoke "parameters" falling back to a plain JSON-schema object.\n',
  );
  return {
    type: 'object',
    properties: {
      family: { type: 'string' },
      subcommand: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['family'],
  };
}

/**
 * Build the `before_provider_request` handler that steers pi's model
 * selection to GSD's tier-resolved id (modelMode: 'active' per
 * capabilities/pi/capability.json). GSD does NOT call `pi.registerProvider` —
 * that registers a NEW model provider; GSD's job here is only to pick a
 * tier-appropriate id AMONG pi's EXISTING built-in anthropic models, so
 * registerProvider would be the wrong primitive (it would wrongly add a fake
 * provider instead of steering the real one).
 *
 * v1 tier policy: GSD does not yet expose a per-turn/per-agent tier signal to
 * this event, so a conservative fixed default tier is used (parameterized —
 * default 'sonnet' — so a future richer signal, or a test, can override it).
 *
 * ASSUMPTION (flagged — verify against a live pi host): the event payload's
 * model field is named `model`, matching the anthropic-messages payload shape
 * (Context7-confirmed for the wire protocol; pi's own before_provider_request
 * event schema was not independently verifiable in this environment). If pi's
 * actual field name differs, this returns the WRONG key and pi's fail-open
 * default takes over only because bare-model-id mismatches degrade to
 * provider-level errors, not GSD-level ones — a discrepancy here needs a
 * live-host smoke test before shipping past this stage.
 *
 * Fail-open: any resolution failure (or a null/falsy resolved model — e.g. an
 * unrecognized tier) returns `undefined`, leaving pi's model choice untouched.
 * NEVER returns a payload with a missing/empty model id.
 *
 * @param {{ tier?: string }} [opts]
 * @returns {(event: object, ctx: object) => Promise<object|undefined>}
 */
function buildBeforeProviderRequestHandler({ tier = 'sonnet' } = {}) {
  return async function onBeforeProviderRequest(event, ctx) {
    try {
      const effectiveCwd = (ctx && ctx.cwd) || process.cwd();
      const { resolveTierEntry } = require(path.join(GSD_CORE, 'bin', 'lib', 'model-resolver.cjs'));
      const { loadConfig } = require(path.join(GSD_CORE, 'bin', 'lib', 'config-loader.cjs'));
      const config = loadConfig(effectiveCwd);
      const overrides = (config && config.model_profile_overrides) || undefined;
      const entry = resolveTierEntry({ runtime: 'pi', tier, overrides });
      const modelId = entry && typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : null;
      if (!modelId) return undefined; // fail-open — leave pi's model untouched
      const basePayload = (event && typeof event === 'object' && event.payload && typeof event.payload === 'object')
        ? event.payload
        : {};
      return { ...basePayload, model: modelId };
    } catch {
      return undefined; // fail-open on any resolution error
    }
  };
}

/**
 * Bounded subprocess bridge to GSD's Claude Code hook scripts. Mirrors
 * .opencode/plugins/gsd-core.js's `runHook` (SUBPROCESS-REUSE): spawns
 * `node <hooks/hookFile>` with the payload piped to stdin, on a bounded
 * timeout. NEVER throws — a missing hook file, a spawn error, or a timeout
 * all degrade to a silent-allow result so a hook problem can never block pi.
 * @param {string} hookFile  filename under hooks/, e.g. "gsd-context-monitor.js"
 * @param {object} payload
 * @param {{ timeout?: number, cwd?: string }} [opts]
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
function runHook(hookFile, payload, opts = {}) {
  const hookPath = path.join(ENGINE_ROOT, 'hooks', hookFile);
  if (!fs.existsSync(hookPath)) return { stdout: '', exitCode: 0, timedOut: false };
  const timeout = opts.timeout || 8000;
  let result;
  try {
    result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      timeout,
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
    });
  } catch {
    return { stdout: '', exitCode: 0, timedOut: false };
  }
  const stdout = (result && typeof result.stdout === 'string') ? result.stdout.trim() : '';
  const exitCode = (result && result.status != null) ? result.status : 0;
  return { stdout, exitCode, timedOut: !!(result && result.signal === 'SIGTERM') };
}

module.exports = function gsdPiExtension(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdPiExtension: pi ExtensionAPI is required');
  }
  if (!pi.zod) {
    throw new TypeError('gsdPiExtension: a Zod-capable ExtensionAPI is required');
  }

  const fs = require('node:fs');
  const path = require('node:path');
  const advisedFiles = new Set();
  const activeGsdTaskIds = new Map();
  const languagePromptCwds = new Set();

  function taskIdsFor(cwd) {
    const projectPath = path.resolve(cwd);
    let taskIds = activeGsdTaskIds.get(projectPath);
    if (!taskIds) {
      taskIds = new Set();
      activeGsdTaskIds.set(projectPath, taskIds);
    }
    return taskIds;
  }

  function trackGsdTaskRequest(event, cwd) {
    const input = event?.input;
    if (event?.toolName !== 'task' || !input || typeof input.agent !== 'string' || !input.agent.startsWith('gsd-')) return;
    const taskIds = taskIdsFor(cwd);
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    for (const task of tasks) {
      if (typeof task?.id === 'string' && task.id) taskIds.add(task.id);
    }
  }

  function trackGsdTaskProgress(event, cwd) {
    const progress = event?.details?.progress;
    if (!Array.isArray(progress)) return;
    const taskIds = taskIdsFor(cwd);
    for (const task of progress) {
      if (typeof task?.agent === 'string' && task.agent.startsWith('gsd-') && typeof task.id === 'string' && task.id) {
        taskIds.add(task.id);
      }
    }
  }

  function releaseSettledGsdTasks(event, cwd) {
    if (event?.toolName !== 'job') return;
    const jobs = event?.details?.jobs;
    if (!Array.isArray(jobs)) return;
    const projectPath = path.resolve(cwd);
    const taskIds = activeGsdTaskIds.get(projectPath);
    if (!taskIds) return;
    for (const job of jobs) {
      if (job?.status !== 'running' && typeof job?.id === 'string') taskIds.delete(job.id);
    }
    if (taskIds.size === 0) activeGsdTaskIds.delete(projectPath);
  }

  function nativeTaskWaitBlock(event, cwd) {
    const input = event?.input || {};
    const taskIds = activeGsdTaskIds.get(path.resolve(cwd));
    if (event?.toolName !== 'irc' || input.op !== 'wait' || typeof input.from !== 'string' || !taskIds?.has(input.from)) return null;
    return `GSD OMP guard: "${input.from}" is a native task job. Do not wait for task completion through IRC; use job poll ["${input.from}"] and consume its task result instead.`;
  }

  function resolveEngineRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'gsd-core'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(startDir, '..');
  }

  const ENGINE_ROOT = resolveEngineRoot(__dirname);
  const CLI_PATH = [
    path.join(ENGINE_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(ENGINE_ROOT, 'bin', 'gsd-tools.cjs'),
  ].find(fs.existsSync);

  function parseCommandLine(input) {
    const tokens = String(input || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    return tokens.map((token) => {
      const first = token[0];
      return first === '"' || first === "'" ? token.slice(1, -1) : token;
    });
  }


  function invokeAsync({ family = 'query', subcommand = 'help', args = [], cwd = process.cwd(), raw = false, signal }) {
    if (!CLI_PATH) return Promise.resolve({ ok: false, stdout: '', stderr: `GSD CLI is unavailable beneath ${ENGINE_ROOT}`, exitCode: 1, cancelled: false });
    const { spawn } = require('node:child_process');
    const cliArgs = [CLI_PATH, family, subcommand, ...args];
    if (raw) cliArgs.push('--raw');
    return new Promise((resolve) => {
      const child = spawn(process.execPath, cliArgs, { cwd, env: { ...process.env, GSD_RUNTIME: 'omp' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        child.kill('SIGTERM');
      };
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        signal?.removeEventListener('abort', abort);
        resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, exitCode: 1, cancelled });
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        resolve({ ok: !cancelled && code === 0, stdout, stderr, exitCode: code ?? 1, cancelled });
      });
    });
  }

  function readConfig(cwd) {
    try {
      return JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function isGsdProject(cwd) {
    const planningDir = path.join(cwd, '.planning');
    return ['PROJECT.md', 'ROADMAP.md', 'STATE.md'].some((name) => fs.existsSync(path.join(planningDir, name)));
  }

  function nextActionPath(cwd) {
    return path.join(cwd, '.planning', '.omp-next-action.json');
  }

  function readNextAction(cwd) {
    try {
      const action = JSON.parse(fs.readFileSync(nextActionPath(cwd), 'utf8'));
      return typeof action?.command === 'string' && typeof action?.label === 'string' ? action : null;
    } catch {
      return null;
    }
  }

  function persistNextAction(cwd, action) {
    const target = nextActionPath(cwd);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(action, null, 2) + '\n');
      fs.renameSync(temporary, target);
      return true;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  function extractNextAction(output) {
    const text = String(output || '');
    const header = text.match(/(?:^|\n)\s*▶\s*Next Up\s*\n/m);
    if (!header || header.index === undefined) return null;
    const block = text.slice(header.index + header[0].length).split(/\r?\n\s*(?:─{8,}|-{8,})\s*(?:\r?\n|$)/)[0];
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const command = lines.find((line) => /^\/(?:skill:)?gsd(?:[-:][A-Za-z0-9_-]+)?(?:\s|$)/.test(line));
    if (!command) return null;
    const label = lines.find((line) => line !== command && !/^\/(?:new|clear)\b/.test(line) && !/^then:?$/i.test(line));
    if (!label) return null;
    return {
      label,
      command,
      requiresFreshContext: lines.some((line) => /^\/(?:new|clear)\s+then:?$/i.test(line)),
    };
  }

  function checkpointPath(cwd) {
    return path.join(cwd, '.planning', '.omp-checkpoint.json');
  }

  function readCheckpoint(cwd) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath(cwd), 'utf8'));
      return Number.isInteger(checkpoint?.phase) && Number.isInteger(checkpoint?.wave) && Number.isInteger(checkpoint?.waveTotal) && Number.isInteger(checkpoint?.plansDone) && Number.isInteger(checkpoint?.plansTotal) && typeof checkpoint?.plan === 'string'
        ? checkpoint
        : null;
    } catch {
      return null;
    }
  }

  function persistCheckpoint(cwd, checkpoint) {
    const target = checkpointPath(cwd);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(checkpoint, null, 2) + '\n');
      fs.renameSync(temporary, target);
      return true;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  function extractCheckpoint(output) {
    const match = String(output || '').match(/^\s*\[checkpoint\]\s+phase\s+(\d+)\s+wave\s+(\d+)\/(\d+)\s+plan\s+([^\s]+)\s+complete\s+\((\d+)\/(\d+)\s+plans\s+done\)\s*$/mi);
    if (!match) return null;
    const [, phase, wave, waveTotal, plan, plansDone, plansTotal] = match;
    return {
      phase: Number(phase),
      wave: Number(wave),
      waveTotal: Number(waveTotal),
      plan,
      plansDone: Number(plansDone),
      plansTotal: Number(plansTotal),
    };
  }

  function taskResultsPath(cwd) {
    return path.join(cwd, '.planning', '.omp-task-results.json');
  }

  function readTaskResults(cwd) {
    try {
      const results = JSON.parse(fs.readFileSync(taskResultsPath(cwd), 'utf8'));
      return Array.isArray(results) ? results : [];
    } catch {
      return [];
    }
  }

  function persistTaskResult(cwd, result) {
    const target = taskResultsPath(cwd);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      const results = readTaskResults(cwd);
      const index = results.findIndex((entry) => entry.phase === result.phase && entry.plan === result.plan && entry.task === result.task);
      if (index === -1) results.push(result);
      else results[index] = result;
      fs.writeFileSync(temporary, JSON.stringify(results, null, 2) + '\n');
      fs.renameSync(temporary, target);
      return true;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  function extractTaskResult(output) {
    const match = String(output || '').match(/\[gsd-task-result\]\s+phase\s+(\d+)\s+plan\s+([^\s]+)\s+task\s+([A-Za-z0-9_.-]+)\s+(completed|failed|cancelled)(?=$|[\s"'`<])/i);
    if (!match) return null;
    const [, phase, plan, task, status] = match;
    return { phase: Number(phase), plan, task, status };
  }


  function persistResponseLanguage(cwd, config, language) {
    const configPath = path.join(cwd, '.planning', 'config.json');
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ ...config, response_language: language }, null, 2) + '\n');
      fs.renameSync(temporaryPath, configPath);
      return true;
    } catch {
      try { fs.unlinkSync(temporaryPath); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  async function promptForLanguage(ctx) {
    const config = readConfig(ctx.cwd);
    if (!ctx.hasUI || !isGsdProject(ctx.cwd) || !config || config.response_language || typeof ctx.ui?.select !== 'function') return false;
    const selection = await ctx.ui.select('GSD language / GSD 界面语言', [
      { label: '简体中文', description: 'Use Simplified Chinese for GSD status and guidance.' },
      { label: 'English', description: 'Use English for GSD status and guidance.' },
    ]);
    const label = typeof selection === 'string' ? selection : selection?.label || selection?.value;
    const language = label === '简体中文' ? 'Simplified Chinese' : label === 'English' ? 'English' : null;
    if (!language || !persistResponseLanguage(ctx.cwd, config, language)) return false;
    ctx.ui.notify?.(`GSD language set to ${language}`, 'info');
    return true;
  }

  function scheduleLanguagePrompt(ctx) {
    if (languagePromptCwds.has(ctx.cwd)) return;
    languagePromptCwds.add(ctx.cwd);
    void promptForLanguage(ctx)
      .then((changed) => { if (changed) updateStatus(ctx); })
      .catch(() => {})
      .finally(() => languagePromptCwds.delete(ctx.cwd));
  }

  function stateReminder(cwd) {
    const config = readConfig(cwd);
    if (!config?.hooks?.workflow_guard) return null;

    const statePath = path.join(cwd, '.planning', 'STATE.md');
    const stateHead = fs.existsSync(statePath)
      ? fs.readFileSync(statePath, 'utf8').split(/\r?\n/).slice(0, 20).join('\n')
      : '';
    const lines = ['## Project State Reminder', ''];
    lines.push(stateHead
      ? 'STATE.md exists — check blockers and the current phase before acting.\n' + stateHead
      : 'No STATE.md exists — use /gsd-new-project when starting a new project.');
    lines.push('', `Config mode: "${config.mode || 'unknown'}"`);
    return lines.join('\n');
  }

  function stateSnapshot(cwd) {
    const statePath = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(statePath)) return null;

    let state;
    try {
      state = fs.readFileSync(statePath, 'utf8');
    } catch {
      return { unreadable: true };
    }
    const match = state.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { unreadable: true };
    const [, frontmatter, body] = match;
    const field = (name) => frontmatter.match(new RegExp(`^\\s*${name}:\\s*"?([^"\\r\\n]+)`, 'm'))?.[1]?.trim();
    const riskHeadings = [...body.matchAll(/^##\s+(Blockers|Concerns|Blockers\/Concerns)\s*$/gmi)];
    const risks = [];
    for (const [index, heading] of riskHeadings.entries()) {
      const sectionStart = heading.index + heading[0].length;
      const sectionEnd = riskHeadings[index + 1]?.index ?? body.length;
      const section = body.slice(sectionStart, sectionEnd).split(/^##\s/m)[0];
      const headingName = heading[1].toLowerCase();
      for (const bullet of section.matchAll(/^\s*-\s+(.+)$/gm)) {
        const title = bullet[1].trim();
        const blocker = headingName === 'blockers' || /^(?:\[blocker\]|⛔)/i.test(title);
        risks.push({ severity: blocker ? 'blocker' : 'concern', title });
      }
    }
    const blockers = risks.filter(({ severity }) => severity === 'blocker').length;
    const concerns = risks.length - blockers;

    return {
      phase: field('current_phase') || '—',
      phaseName: field('current_phase_name'),
      status: field('status') || 'unknown',
      totalPlans: field('total_plans'),
      completedPlans: field('completed_plans'),
      blockers,
      concerns,
      risks,
      nextStep: body.match(/^Status:\s*(.+)$/m)?.[1]?.trim(),
    };
  }

  function usesChinese(cwd) {
    const language = String(readConfig(cwd)?.response_language || '');
    return /(^zh\b|chinese|中文)/i.test(language);
  }

  function localizedStatus(status, cwd) {
    const label = {
      executing: { en: 'Executing', zh: '执行中' },
      planning: { en: 'Planning', zh: '规划中' },
      verifying: { en: 'Verifying', zh: '验证中' },
      blocked: { en: 'Blocked', zh: '已阻塞' },
      ready_for_verification: { en: 'Ready to verify', zh: '待验证' },
      completed: { en: 'Completed', zh: '已完成' },
    }[status];
    return label ? label[usesChinese(cwd) ? 'zh' : 'en'] : status;
  }

  function localizedNextStep(nextStep, cwd) {
    if (!nextStep || !usesChinese(cwd)) return nextStep;
    return {
      'Ready for phase verification': '等待阶段验证',
    }[nextStep] || nextStep;
  }

  function riskIndicator(state) {
    return `${state.blockers ? ` ⛔${state.blockers}` : ''}${state.concerns ? ` ⚠${state.concerns}` : ''}`;
  }

  function riskSummary(state, chinese) {
    if (!state.blockers && !state.concerns) return chinese ? '无' : 'None';
    const parts = [];
    if (state.blockers) parts.push(chinese ? `⛔ ${state.blockers} 阻塞` : `⛔ ${state.blockers} blocker${state.blockers === 1 ? '' : 's'}`);
    if (state.concerns) parts.push(chinese ? `⚠ ${state.concerns} 关注` : `⚠ ${state.concerns} concern${state.concerns === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  function phaseArtifactProgress(cwd, state) {
    const phase = String(state?.phase || '').padStart(2, '0');
    if (!/^\d+$/.test(phase)) return null;
    const phasesPath = path.join(cwd, '.planning', 'phases');
    try {
      const phaseDirectory = fs.readdirSync(phasesPath, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.startsWith(`${phase}-`));
      if (!phaseDirectory) return null;
      const artifacts = fs.readdirSync(path.join(phasesPath, phaseDirectory.name));
      const planPattern = new RegExp(`^${phase}-(\\d+)-PLAN\\.md$`);
      const summaryPattern = new RegExp(`^${phase}-(\\d+)-SUMMARY\\.md$`);
      const planIds = new Set(artifacts.map((name) => planPattern.exec(name)?.[1]).filter(Boolean));
      const completedIds = new Set(artifacts
        .map((name) => summaryPattern.exec(name)?.[1])
        .filter((planId) => planId && planIds.has(planId)));
      return planIds.size > 0 ? { plans: planIds.size, summaries: completedIds.size } : null;
    } catch {
      return null;
    }
  }

  function planProgress(cwd, state, width = 10) {
    const artifactProgress = phaseArtifactProgress(cwd, state);
    const total = artifactProgress?.plans ?? Number(state?.totalPlans);
    const completed = artifactProgress?.summaries ?? Number(state?.completedPlans);
    if (!Number.isInteger(total) || !Number.isInteger(completed) || total < 1 || completed < 0 || completed > total) return null;
    const filled = Math.round((completed / total) * width);
    return { completed, total, scope: artifactProgress ? 'phase' : 'project', bar: `${'█'.repeat(filled)}${'░'.repeat(width - filled)}` };
  }

  function checkpointStatus(cwd, state) {
    const checkpoint = readCheckpoint(cwd);
    if (state.status !== 'executing' || !checkpoint || Number(String(state.phase).replace(/^0+/, '') || 0) !== checkpoint.phase) return null;
    if (usesChinese(cwd)) return `GSD ${state.phase} · 波 ${checkpoint.wave}/${checkpoint.waveTotal} · ${checkpoint.plansDone}/${checkpoint.plansTotal} 计划 · ${checkpoint.plan} 完成`;
    return `GSD ${state.phase} · W${checkpoint.wave}/${checkpoint.waveTotal} · ${checkpoint.plansDone}/${checkpoint.plansTotal} · ${checkpoint.plan} complete`;
  }

  function statusText(cwd) {
    const state = stateSnapshot(cwd);
    if (!state) return null;
    if (state.unreadable) return usesChinese(cwd) ? 'GSD · 状态文件无法解析' : 'GSD · state unreadable';
    const checkpoint = checkpointStatus(cwd, state);
    if (checkpoint) return `${checkpoint}${riskIndicator(state)}`;
    const progressValue = planProgress(cwd, state);
    const progress = progressValue
      ? progressValue.scope === 'phase'
        ? usesChinese(cwd) ? ` · 阶段计划 ${progressValue.completed}/${progressValue.total}` : ` · Phase plans ${progressValue.completed}/${progressValue.total}`
        : usesChinese(cwd) ? ` · 项目计划 ${progressValue.completed}/${progressValue.total}` : ` · Plans ${progressValue.completed}/${progressValue.total}`
      : '';
    return `GSD ${state.phase}${progress} · ${localizedStatus(state.status, cwd)}${riskIndicator(state)}`;
  }

  function localizedStatusSummary(cwd) {
    const chinese = usesChinese(cwd);
    const state = stateSnapshot(cwd);
    if (!state) return chinese ? '未检测到 GSD 项目状态。' : 'No GSD project state detected.';
    if (state.unreadable) return chinese ? 'GSD 状态文件无法解析。' : 'GSD state file could not be parsed.';
    const progressValue = planProgress(cwd, state);
    const progressText = progressValue
      ? chinese
        ? `${progressValue.scope === 'phase' ? '阶段计划' : '项目计划'} ${progressValue.completed} / ${progressValue.total} 已完成`
        : `${progressValue.scope === 'phase' ? 'Phase plans' : 'Plans'} ${progressValue.completed} / ${progressValue.total} complete`
      : chinese ? '暂无计划进度' : 'No plan progress available';
    return chinese
      ? [
        'GSD 项目状态',
        `阶段：${state.phase}${state.phaseName ? ` / ${state.phaseName}` : ''}`,
        `状态：${localizedStatus(state.status, cwd)}`,
        `计划：${progressText}`,
        `风险：${riskSummary(state, true)}`,
        `下一步：${localizedNextStep(state.nextStep, cwd) || '请查看 .planning/STATE.md'}`,
      ].join('\n')
      : [
        'GSD Project Status',
        `Phase: ${state.phase}${state.phaseName ? ` / ${state.phaseName}` : ''}`,
        `Status: ${localizedStatus(state.status, cwd)}`,
        `Plans: ${progressText}`, 
        `Risks: ${riskSummary(state, false)}`,
        `Next: ${state.nextStep || 'See .planning/STATE.md'}`,
      ].join('\n');
  }

  function widgetColor(code, text) {
    return `\u001b[${code}m${text}\u001b[0m`;
  }

  function widgetRiskLine(state, chinese) {
    const parts = [];
    if (state.blockers) parts.push(widgetColor(31, chinese ? `⛔ ${state.blockers} 阻塞` : `⛔ ${state.blockers} blocker${state.blockers === 1 ? '' : 's'}`));
    if (state.concerns) parts.push(widgetColor(33, chinese ? `⚠ ${state.concerns} 关注` : `⚠ ${state.concerns} concern${state.concerns === 1 ? '' : 's'}`));
    return parts.join(' · ');
  }


  function widgetLines(cwd) {
    const chinese = usesChinese(cwd);
    const action = readNextAction(cwd);
    const state = stateSnapshot(cwd);
    if (!state && !action) return [];
    if (state?.unreadable) return [widgetColor(31, chinese ? 'GSD · 状态文件无法解析' : 'GSD · state unreadable')];
    const hasRisks = Boolean(state?.blockers || state?.concerns);
    if (!hasRisks && !action) return [];
    const heading = action
      ? widgetColor(36, chinese ? 'GSD · 下一步' : 'GSD · Next Up')
      : widgetColor(33, chinese ? 'GSD · 需要关注' : 'GSD · Attention');
    const rows = [];
    if (hasRisks) rows.push(widgetRiskLine(state, chinese));
    if (action) rows.push(action.label.slice(0, 92));
    const lines = [heading, ...rows.map((row, index) => `${index === rows.length - 1 ? '└─' : '├─'} ${row}`)];
    if (action) lines.push(`   ${widgetColor(2, action.command)}`);
    return lines;
  }

  function updateStatus(ctx) {
    if (!isGsdProject(ctx.cwd)) return;
    if (ctx.ui?.setStatus) ctx.ui.setStatus('gsd', statusText(ctx.cwd) || '');
    if (ctx.hasUI && ctx.ui?.setWidget) {
      ctx.ui.setWidget('gsd', widgetLines(ctx.cwd), { placement: 'aboveEditor' });
    }
  }

  function workflowAdvisory(event, cwd) {
    if (!isGsdProject(cwd)) return null;
    const config = readConfig(cwd);
    if (!config?.hooks?.workflow_guard) return null;
    if (!new Set(['edit', 'write', 'ast_edit', 'ast-edit']).has(event.toolName)) return null;

    const input = event.input || {};
    const filePath = input.path || input.filePath || input.file_path || input.file || '';
    if (!filePath || filePath.includes('.planning/')) return null;
    if (/\.(gitignore|env)|\/(CLAUDE|AGENTS|GEMINI)\.md$|settings\.json$/i.test(filePath)) return null;
    const advisoryKey = path.resolve(cwd, filePath);
    if (advisedFiles.has(advisoryKey)) return null;
    advisedFiles.add(advisoryKey);

    return `⚠️ GSD workflow advisory: ${path.basename(filePath)} is being edited outside a tracked GSD workflow. ` +
      'Use /gsd-fast or /gsd-quick when the change should update GSD state and produce a summary.';
  }

  function commandResultContent(result, cwd) {
    const chinese = usesChinese(cwd);
    const output = result.stdout || result.stderr || (chinese
      ? `GSD 命令以退出码 ${result.exitCode} 结束。`
      : `GSD command exited with code ${result.exitCode}.`);
    const headline = result.exitCode === 0
      ? chinese ? '✓ GSD 命令已完成' : '✓ GSD command completed'
      : chinese ? '✗ GSD 命令失败' : '✗ GSD command failed';
    const recovery = result.exitCode === 0
      ? chinese ? `下一步：${localizedNextStep(stateSnapshot(cwd)?.nextStep, cwd) || '使用 /gsd-next 查看建议。'}` : `Next: ${stateSnapshot(cwd)?.nextStep || 'Use /gsd-next for a recommendation.'}`
      : chinese ? '建议：使用 /gsd-status 查看项目状态和风险。' : 'Recovery: use /gsd-status to review project state and risks.';
    return [headline, recovery, '', output].join('\n');
  }

  function riskDetails(state, chinese) {
    if (!state.risks.length) return chinese ? '无风险项。' : 'No risks recorded.';
    return state.risks.map(({ severity, title }) => {
      const prefix = severity === 'blocker' ? '⛔' : '⚠';
      const label = severity === 'blocker'
        ? chinese ? '阻塞' : 'Blocker'
        : chinese ? '关注' : 'Concern';
      return `${prefix} ${label}: ${title.replace(/^(?:\[blocker\]|\[concern\]|⛔|⚠)\s*/i, '')}`;
    }).join('\n');
  }

  async function emitNextStep(ctx, state) {
    const chinese = usesChinese(ctx.cwd);
    const content = chinese
      ? [
        'GSD 下一步',
        `状态：${localizedStatus(state.status, ctx.cwd)}`,
        `风险：${riskSummary(state, true)}`,
        `建议：${localizedNextStep(state.nextStep, ctx.cwd) || '请查看 .planning/STATE.md'}`,
      ].join('\n')
      : [
        'GSD Next Step',
        `Status: ${localizedStatus(state.status, ctx.cwd)}`,
        `Risks: ${riskSummary(state, false)}`,
        `Recommendation: ${state.nextStep || 'See .planning/STATE.md'}`,
      ].join('\n');
    await pi.sendMessage({ customType: 'gsd-next-step', content, display: true }, { triggerTurn: false });
  }

  function continuationSummary(action, chinese) {
    return chinese
      ? `下一步：${action.label}\n命令：${action.command}\n${action.requiresFreshContext ? '需要新的 GSD session。' : ''}`
      : `Next: ${action.label}\nCommand: ${action.command}\n${action.requiresFreshContext ? 'A new GSD session is required.' : ''}`;
  }

  async function startContinuationSession(ctx, action) {
    const chinese = usesChinese(ctx.cwd);
    if (!ctx.newSession) {
      if (ctx.ui?.setEditorText) ctx.ui.setEditorText('/new');
      return;
    }
    const confirmed = ctx.ui?.confirm
      ? await ctx.ui.confirm(chinese ? '新开 GSD Session' : 'Start new GSD session', chinese
        ? '将创建新的 OMP session；不会自动执行下一条 GSD 命令。'
        : 'A new OMP session will be created. The next GSD command will not run automatically.')
      : false;
    if (!confirmed) return;
    await ctx.waitForIdle?.();
    await ctx.newSession({
      parentSession: ctx.sessionManager?.getSessionFile?.(),
      setup: async (sessionManager) => {
        sessionManager.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: `${chinese ? '待确认的 GSD 下一步' : 'Pending GSD next step'}:\n${continuationSummary(action, chinese)}\n\n${chinese ? '请先展示该动作并等待我的确认，不要自动执行。' : 'Show this action and wait for my confirmation; do not execute it automatically.'}` }],
          timestamp: Date.now(),
        });
      },
    });
  }

  async function choosePendingContinuation(ctx, action) {
    const chinese = usesChinese(ctx.cwd);
    if (!ctx.hasUI || !ctx.ui?.select) {
      await pi.sendMessage({ customType: 'gsd-continuation', content: continuationSummary(action, chinese), display: true }, { triggerTurn: false });
      return;
    }
    const choices = chinese
      ? [
        { label: '新开 GSD Session', description: '新 session 中展示下一步，不自动执行。' },
        { label: '复制后续命令', description: '将 /new 和后续 GSD 命令放入编辑器。' },
        { label: '查看状态与风险', description: '先确认当前项目状态。' },
        { label: '稍后处理', description: '保留待处理的下一步。' },
      ]
      : [
        { label: 'Start new GSD session', description: 'Show the next step in a new session without running it.' },
        { label: 'Copy continuation commands', description: 'Put /new and the next GSD command in the editor.' },
        { label: 'Review status and risks', description: 'Confirm the current project state first.' },
        { label: 'Later', description: 'Keep this next step pending.' },
      ];
    let choice;
    try {
      choice = await ctx.ui.select(chinese ? 'GSD 下一步' : 'GSD next step', choices);
    } catch {
      return;
    }
    const label = typeof choice === 'string' ? choice : choice?.label || choice?.value;
    if (label === choices[0].label) return startContinuationSession(ctx, action);
    if (label === choices[1].label) {
      ctx.ui.setEditorText?.(`/new\n${action.command}`);
      return;
    }
    if (label === choices[2].label) {
      await pi.sendMessage({ customType: 'gsd-continuation', content: `${continuationSummary(action, chinese)}\n\n${localizedStatusSummary(ctx.cwd)}`, display: true }, { triggerTurn: false });
    }
  }



  async function chooseNextAction(ctx, state) {
    const continuation = readNextAction(ctx.cwd);
    if (continuation) return choosePendingContinuation(ctx, continuation);
    const chinese = usesChinese(ctx.cwd);
    if (!ctx.hasUI || !ctx.ui?.select) return emitNextStep(ctx, state);
    const choices = chinese
      ? [
        { label: '查看状态', description: '显示阶段、计划和下一步。' },
        { label: '查看风险', description: '显示阻塞和关注项。' },
        { label: '准备下一步', description: '将下一步说明放入编辑器。' },
      ]
      : [
        { label: 'View status', description: 'Show phase, plan progress, and next step.' },
        { label: 'Review risks', description: 'Show blockers and concerns.' },
        { label: 'Prepare next step', description: 'Put the next-step instruction in the editor.' },
      ];
    let choice;
    try {
      choice = await ctx.ui.select(chinese ? 'GSD 下一步' : 'GSD next step', choices);
    } catch {
      return;
    }
    const label = typeof choice === 'string' ? choice : choice?.label || choice?.value;
    if (label === choices[0].label) return emitNextStep(ctx, state);
    if (label === choices[1].label) {
      await pi.sendMessage({
        customType: 'gsd-risk-details',
        content: `${chinese ? 'GSD 风险' : 'GSD Risks'}\n${riskDetails(state, chinese)}`,
        display: true,
      }, { triggerTurn: false });
      return;
    }
    if (state.blockers) {
      await pi.sendMessage({
        customType: 'gsd-next-blocked',
        content: chinese ? `下一步已暂停：${riskSummary(state, true)}。\n${riskDetails(state, true)}` : `Next step is paused: ${riskSummary(state, false)}.\n${riskDetails(state, false)}`,
        display: true,
      }, { triggerTurn: false });
      return;
    }
    const next = localizedNextStep(state.nextStep, ctx.cwd) || (chinese ? '请查看 .planning/STATE.md' : 'See .planning/STATE.md');
    const confirmed = ctx.ui.confirm
      ? await ctx.ui.confirm(chinese ? '准备下一步' : 'Prepare next step', next)
      : true;
    if (confirmed && ctx.ui.setEditorText) ctx.ui.setEditorText(next);
  }

  function nativeExecutePrompt(input) {
    const tokens = parseCommandLine(input);
    const [phase, ...options] = tokens;
    if (!/^\d+$/.test(phase || '')) return null;
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option === '--wave') {
        if (!/^\d+$/.test(options[index + 1] || '')) return null;
        index += 1;
      } else if (!['--gaps-only', '--interactive', '--tdd', '--auto'].includes(option)) {
        return null;
      }
    }

    const phaseCommand = [phase, ...options].join(' ');
    return `# OMP native GSD phase execution

Execute GSD phase \`${phaseCommand}\` end-to-end using the execute-phase workflow and its existing safety gates.

OMP dispatch contract:
- Use native \`task\` for every non-interactive executor dispatch. One plan is one task; independent plans in a wave are one task batch. Never use \`irc wait\` for task completion: IRC is coordination-only. Use \`job poll\` for the spawned task ids and consume the native task result before dispatching the next wave.
- Assign each executor a stable id \`Phase${phase}Plan{PLAN}Executor\`, an operator-facing description, the \`gsd-executor\` role, the complete plan assignment, and the relevant GSD context paths.
- Every executor that writes repository files MUST request \`isolated: true\`. If isolated execution is unavailable, stop and report the blocked plan; never fall back to main-checkout writes or manual \`git worktree\` commands.
- \`--interactive\` is the only sequential inline mode. All other executor work uses native task dispatch.
- Native task completion is not a completion gate. Reconcile its \`[gsd-task-result]\` line, then require the existing SUMMARY.md, commit, merge, post-wave verification, and STATE.md updates before marking the plan complete.
- When an isolated task reports \`merge-summary\` patches applied, treat those changes as an uncommitted handoff: inspect \`git status\` and the patch, run the required verification, then create the plan's required commit in the parent checkout. Never recreate child file edits by hand.
- After each reconciled plan, emit exactly \`[checkpoint] phase ${phase} wave {N}/{M} plan {PLAN} complete ({P}/{Q} plans done)\`, or the corresponding \`failed\` / \`checkpoint\` status.
- Preserve GSD's no-duplicate-work, failure, merge, and verification rules. Do not invent a separate progress UI; OMP owns native job progress and cancellation.
`;
  }

  pi.registerCommand('gsd-execute-phase', {
    description: 'Execute a GSD phase through OMP native task waves.',
    handler: async (input, ctx) => {
      const prompt = nativeExecutePrompt(input);
      if (!prompt) {
        await pi.sendMessage({ customType: 'gsd-execute-input-error', content: 'Usage: /gsd-execute-phase <phase> [--wave N] [--gaps-only] [--interactive] [--tdd] [--auto]', display: true }, { triggerTurn: false });
        return;
      }
      await pi.sendMessage({ customType: 'gsd-native-execute-phase', content: prompt, display: true }, { triggerTurn: true });
    },
  });

  pi.registerCommand('gsd', {
    description: 'Invoke GSD CLI: /gsd <family> <subcommand> [args].',
    handler: async (input, ctx) => {
      const [family = 'query', subcommand = 'help', ...args] = parseCommandLine(input);
      const result = await invokeAsync({ family, subcommand, args, cwd: ctx.cwd });
      const nextAction = result.exitCode === 0 && extractNextAction(result.stdout);
      const checkpoint = result.exitCode === 0 && extractCheckpoint(result.stdout);
      if (nextAction) persistNextAction(ctx.cwd, nextAction);
      if (checkpoint) persistCheckpoint(ctx.cwd, checkpoint);
      if (nextAction || checkpoint) updateStatus(ctx);
      await pi.sendMessage({
        customType: 'gsd-command-result',
        content: commandResultContent(result, ctx.cwd),
        display: true,
        details: result,
      }, { triggerTurn: false });
      if (nextAction && ctx.hasUI) await choosePendingContinuation(ctx, nextAction);
    },
  });

  pi.registerCommand('gsd-status', {
    description: 'Show a localized GSD project summary.',
    handler: async (_input, ctx) => {
      await pi.sendMessage({
        customType: 'gsd-status-summary',
        content: localizedStatusSummary(ctx.cwd),
        display: true,
      }, { triggerTurn: false });
    },
  });

  pi.registerCommand('gsd-next', {
    description: 'Show or prepare the next localized GSD action.',
    handler: async (_input, ctx) => {
      const continuation = readNextAction(ctx.cwd);
      if (continuation) {
        await choosePendingContinuation(ctx, continuation);
        return;
      }
      const state = stateSnapshot(ctx.cwd);
      if (!state || state.unreadable) {
        await pi.sendMessage({
          customType: 'gsd-next-step',
          content: localizedStatusSummary(ctx.cwd),
          display: true,
        }, { triggerTurn: false });
        return;
      }
      await chooseNextAction(ctx, state);
    },
  });

  const z = pi.zod;
  pi.registerTool({
    name: 'gsd_invoke',
    label: 'GSD Invoke',
    description: 'Invoke a GSD command family and return the structured result.',
    parameters: z.object({
      family: z.string().default('query'),
      subcommand: z.string().default('help'),
      args: z.array(z.string()).default([]),
      raw: z.boolean().optional(),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const progressMessage = () => {
        const state = stateSnapshot(ctx.cwd);
        const progress = planProgress(ctx.cwd, state);
        const activity = `${params.family} ${params.subcommand}`;
        const detail = progress ? `\n${progress.bar} ${progress.completed}/${progress.total}` : '';
        return `GSD · ${activity}${detail}`;
      };
      onUpdate?.({ content: [{ type: 'text', text: progressMessage() }] });
      const timer = onUpdate ? setInterval(() => onUpdate({ content: [{ type: 'text', text: progressMessage() }] }), 250) : null;
      try {
        const result = await invokeAsync({ ...params, cwd: ctx.cwd, signal });
        return {
          content: [{ type: 'text', text: result.cancelled ? 'GSD command cancelled.' : result.stdout || result.stderr }],
          details: result,
        };
      } finally {
        if (timer) clearInterval(timer);
      }
    }
  });

  pi.on('session_start', (_event, ctx) => {
    if (!isGsdProject(ctx.cwd)) return;
    scheduleLanguagePrompt(ctx);
    updateStatus(ctx);
    if (!ctx.hasUI) return;
    const reminder = stateReminder(ctx.cwd);
    if (reminder) ctx.ui.notify(reminder, 'info');
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (isGsdProject(ctx.cwd)) updateStatus(ctx);
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!isGsdProject(ctx.cwd)) return;
    trackGsdTaskProgress(event, ctx.cwd);
    releaseSettledGsdTasks(event, ctx.cwd);
    const output = (event.content || [])
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.text)
      .join('\n');
    const checkpoint = extractCheckpoint(output);
    const taskResult = extractTaskResult(output);
    if (taskResult) persistTaskResult(ctx.cwd, taskResult);
    if (checkpoint) {
      persistCheckpoint(ctx.cwd, checkpoint);
      updateStatus(ctx);
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    trackGsdTaskRequest(event, ctx.cwd);
    const taskWaitBlock = nativeTaskWaitBlock(event, ctx.cwd);
    if (taskWaitBlock) return { block: true, reason: taskWaitBlock };
    const advisory = workflowAdvisory(event, ctx.cwd);
    if (!advisory) return undefined;
    await pi.sendMessage({
      customType: 'gsd-workflow-advisory',
      content: advisory,
      display: true,
    }, { deliverAs: 'nextTurn', triggerTurn: false });
    return undefined;
  });
  gsdPiExtension._internals = { extractNextAction, extractCheckpoint, extractTaskResult };
};

module.exports._internals = {};
