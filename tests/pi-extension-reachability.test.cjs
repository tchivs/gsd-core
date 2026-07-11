'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');


const gsdPiExtension = require('../pi/gsd.cjs');
const { _internals } = require('../pi/gsd.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { installOmpSkills } = require('../pi/install-omp-skills.cjs');

function mockZod() {
  const chain = () => ({ default: () => chain(), optional: () => chain() });
  return {
    object: () => chain(),
    string: chain,
    array: () => chain(),
    boolean: chain,
  };
}

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: {}, messages: [] };
  return {
    zod: mockZod(),
    registerCommand(name, definition) { recorded.commands[name] = definition; },
    registerTool(definition) { recorded.tools[definition.name] = definition; },
    on(event, handler) { recorded.events[event] = handler; },
    async sendMessage(message, options) { recorded.messages.push({ message, options }); },
    _recorded: recorded,
  };
}

const ANSI_ESCAPE = String.fromCharCode(27);

function stripAnsi(text) {
  return text.replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g'), '');
}

test('the OMP bridge registers command, tool, and lifecycle hooks', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  assert.equal(typeof pi._recorded.commands.gsd.handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-status'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-execute-phase'].handler, 'function');
  assert.equal(typeof pi._recorded.commands['gsd-next'].handler, 'function');
  assert.equal(typeof pi._recorded.tools.gsd_invoke.execute, 'function');
  assert.equal(typeof pi._recorded.events.session_start, 'function');
  assert.equal(typeof pi._recorded.events.tool_call, 'function');
  assert.equal(typeof pi._recorded.events.tool_result, 'function');
  assert.equal(typeof pi._recorded.events.turn_end, 'function');
});

test('the /gsd command dispatches through the GSD CLI', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands.gsd.handler('query phase.next-decimal 01', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-command-result');
  assert.match(pi._recorded.messages[0].message.content, /^✓ GSD command completed/);
  assert.match(pi._recorded.messages[0].message.content, /"next"\s*:\s*"01\.1"/);
});

test('the native phase command injects a task-based execution contract', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  await pi._recorded.commands['gsd-execute-phase'].handler('05 --wave 4', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-native-execute-phase');
  assert.equal(pi._recorded.messages[0].options.triggerTurn, true);
  assert.match(pi._recorded.messages[0].message.content, /Execute GSD phase `05 --wave 4`/);
  assert.match(pi._recorded.messages[0].message.content, /Use native `task`/);
  assert.match(pi._recorded.messages[0].message.content, /isolated: true/);
  assert.match(pi._recorded.messages[0].message.content, /never fall back to main-checkout writes or manual `git worktree` commands/i);
  assert.match(pi._recorded.messages[0].message.content, /Never use `irc wait` for task completion/);
  assert.match(pi._recorded.messages[0].message.content, /Use `job poll`/);


  await pi._recorded.commands['gsd-execute-phase'].handler('five', { cwd: path.resolve(__dirname, '..') });
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-execute-input-error');
  assert.equal(pi._recorded.messages.at(-1).options.triggerTurn, false);
});

test('the OMP bridge blocks IRC completion waits for tracked GSD task jobs', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-task-guard-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const ctx = { cwd };

  await pi._recorded.events.tool_call({
    toolName: 'task',
    input: { agent: 'gsd-code-fixer', tasks: [{ id: 'FixPhase02ReviewFindings' }] },
  }, ctx);

  const blocked = await pi._recorded.events.tool_call({
    toolName: 'irc',
    input: { op: 'wait', from: 'FixPhase02ReviewFindings' },
  }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Do not wait for task completion through IRC/);
  assert.match(blocked.reason, /job poll/);

  await pi._recorded.events.tool_result({
    toolName: 'job',
    content: [],
    details: { jobs: [{ id: 'FixPhase02ReviewFindings', status: 'completed' }] },
  }, ctx);
  assert.equal(await pi._recorded.events.tool_call({
    toolName: 'irc',
    input: { op: 'wait', from: 'FixPhase02ReviewFindings' },
  }, ctx), undefined);
});

test('the gsd_invoke tool returns the hub result in OMP tool shape', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = await pi._recorded.tools.gsd_invoke.execute(
    'tool-1',
    { family: 'query', subcommand: 'phase.next-decimal', args: ['01'] },
    undefined,
    undefined,
    { cwd: path.resolve(__dirname, '..') },
  );
  assert.equal(result.content[0].type, 'text');
  assert.equal(JSON.parse(result.content[0].text).next, '01.1');
});

test('the cancellable GSD tool reports progress and stops on abort', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const controller = new AbortController();
  controller.abort();
  const updates = [];
  const result = await pi._recorded.tools.gsd_invoke.execute(
    'tool-cancel',
    { family: 'query', subcommand: 'phase.next-decimal', args: ['01'] },
    controller.signal,
    (update) => updates.push(update),
    { cwd: path.resolve(__dirname, '..') },
  );
  assert.equal(result.content[0].text, 'GSD command cancelled.');
  assert.match(updates[0].content[0].text, /GSD · query phase.next-decimal/);
});

test('the OMP agent installer projects native task and isolation guidance', () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-agents-'));
  const installer = path.resolve(__dirname, '..', 'pi', 'install-omp-agents.cjs');
  const result = spawnSync(process.execPath, [installer, destination], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const executor = fs.readFileSync(path.join(destination, 'gsd-executor.md'), 'utf8');
  assert.match(executor, /OMP native orchestration/);
  assert.match(executor, /isolated: true/);
  assert.match(executor, /Never run git worktree yourself/);
  assert.match(executor, /OMP executor result protocol/);
  assert.match(executor, /Never use `irc wait` for task completion/);
  assert.match(executor, /MUST terminal-yield immediately after its final verification/);
  assert.match(executor, /\[gsd-task-result\] phase \{PHASE\}/);
  const extensionDestination = path.join(destination, 'extensions', 'gsd-omp.ts');
  const extensionInstaller = path.resolve(__dirname, '..', 'pi', 'install-omp-extension.cjs');
  const extensionResult = spawnSync(process.execPath, [extensionInstaller, extensionDestination], { encoding: 'utf8' });
  assert.equal(extensionResult.status, 0, extensionResult.stderr);
  const extensionEntry = fs.readFileSync(extensionDestination, 'utf8');
  assert.match(extensionEntry, /import gsdPiExtension from/);
  assert.match(extensionEntry, /pi\/gsd\.cjs/);
});

test('the OMP development installer projects every GSD skill with runtime paths', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-skills-'));
  const skillsDir = path.join(runtimeRoot, 'skills');
  try {
    const sourceSkillsDir = path.resolve(__dirname, '..', 'skills');
    const expectedCount = fs.readdirSync(sourceSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('gsd-') && fs.existsSync(path.join(sourceSkillsDir, entry.name, 'SKILL.md')))
      .length;
    const installed = installOmpSkills(skillsDir, sourceSkillsDir);
    assert.equal(installed.length, expectedCount);

    const planSkill = fs.readFileSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md'), 'utf8');
    const runtimeWorkflow = path.join(runtimeRoot, 'gsd-core', 'workflows', 'plan-phase.md').split(path.sep).join('/');
    assert.ok(planSkill.includes(`@${runtimeWorkflow}`));
    assert.doesNotMatch(planSkill, /~\/\.claude\/gsd-core/);
    const executeSkill = fs.readFileSync(path.join(skillsDir, 'gsd-execute-phase', 'SKILL.md'), 'utf8');
    assert.match(executeSkill, /<omp_native_execution>/);
    assert.match(executeSkill, /use `job poll`/);
    assert.match(executeSkill, /Never use `irc wait`/);
    assert.match(executeSkill, /MUST terminal-yield immediately after final verification/);
  } finally {
    cleanup(runtimeRoot);
  }
});

test('the generic installer creates a self-contained OMP runtime', () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-runtime-'));
  try {
    const installer = path.resolve(__dirname, '..', 'bin', 'install.js');
    const result = spawnSync(process.execPath, [installer, '--omp', '--global', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), /Installing for Oh My Pi/);
    assert.equal(fs.readFileSync(path.join(destination, 'extensions', 'gsd-omp.ts'), 'utf8'), 'import gsdPiExtension from "./gsd-omp.cjs";\n\nexport default gsdPiExtension;\n');
    assert.ok(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.cjs')));
    assert.ok(fs.existsSync(path.join(destination, 'gsd-core', 'bin', 'gsd-tools.cjs')));
    const executor = fs.readFileSync(path.join(destination, 'agents', 'gsd-executor.md'), 'utf8');
    assert.match(executor, /OMP native orchestration/);
    assert.doesNotMatch(executor, /~\/\.claude\//);
    const executeSkill = fs.readFileSync(path.join(destination, 'skills', 'gsd-execute-phase', 'SKILL.md'), 'utf8');
    assert.match(executeSkill, /<omp_native_execution>/);
    assert.match(executeSkill, /Native `task` is the executor primitive/);
    const progressSkill = fs.readFileSync(path.join(destination, 'skills', 'gsd-progress', 'SKILL.md'), 'utf8');
    assert.match(progressSkill, /<omp_artifact_handling>/);
    assert.match(progressSkill, /truncated summary glob may supply recent-work examples only/);
    const { extensionEventSurfaceFor } = require('../gsd-core/bin/lib/host-integration.cjs');
    assert.deepEqual(extensionEventSurfaceFor('pi'), ['session_start', 'turn_end', 'tool_call', 'tool_result']);
    const { loadUpdateContext } = require('../gsd-core/bin/lib/update-context.cjs');
    assert.deepEqual(loadUpdateContext({ env: { PI_CODING_AGENT_DIR: destination }, preferredConfigDir: destination, preferredRuntime: 'omp' }), {
      installedVersion: '1.7.0-rc.5', scope: 'GLOBAL', runtime: 'omp', gsdDir: destination,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'gsd-file-manifest.json'), 'utf8'));
    assert.ok(manifest.files['extensions/gsd-omp.ts']);
    assert.ok(manifest.files['extensions/gsd-omp.cjs']);
    assert.ok(manifest.files['gsd-core/OMP-SOURCE.json']);
    const minimalResult = spawnSync(process.execPath, [installer, '--omp', '--global', '--minimal', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(minimalResult.status, 0, minimalResult.stderr);
    assert.equal(fs.existsSync(path.join(destination, 'agents', 'gsd-executor.md')), false);
    const uninstallResult = spawnSync(process.execPath, [installer, '--omp', '--global', '--uninstall', '--config-dir', destination], { encoding: 'utf8' });
    assert.equal(uninstallResult.status, 0, uninstallResult.stderr);
    assert.equal(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.ts')), false);
    assert.equal(fs.existsSync(path.join(destination, 'extensions', 'gsd-omp.cjs')), false);
  } finally {
    cleanup(destination);
  }
});

test('the GSD status line displays the most recent checkpoint', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const checkpoint = gsdPiExtension._internals.extractCheckpoint('[checkpoint] phase 05 wave 4/10 plan 05-08 complete (7/23 plans done)');
  assert.deepEqual(checkpoint, { phase: 5, wave: 4, waveTotal: 10, plan: '05-08', plansDone: 7, plansTotal: 23 });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-checkpoint-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
  const statuses = [];
  const ctx = { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } };
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[checkpoint] phase 05 wave 4/10 plan 05-08 complete (7/23 plans done)' }] }, ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-checkpoint.json'), 'utf8')), checkpoint);
  await pi._recorded.events.session_start({}, ctx);
  assert.deepEqual(statuses.at(-1), { key: 'gsd', text: 'GSD 05 · W4/10 · 7/23 · 05-08 complete' });
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: ready_for_verification\n---\n');
  await pi._recorded.events.turn_end({}, ctx);
  assert.deepEqual(statuses.at(-1), { key: 'gsd', text: 'GSD 05 · Ready to verify' });
});

test('the OMP adapter persists native executor task results', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = gsdPiExtension._internals.extractTaskResult('[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor completed');
  assert.deepEqual(result, { phase: 5, plan: '05-08', task: 'Phase05Plan0508Executor', status: 'completed' });
  assert.deepEqual(
    gsdPiExtension._internals.extractTaskResult('{"message":"[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor failed"}'),
    { ...result, status: 'failed' },
  );

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-results-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "05"\nstatus: executing\n---\n');
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor completed' }] }, { cwd });
  await pi._recorded.events.tool_result({
    toolName: 'job',
    content: [{ type: 'text', text: '## Completed\n<output>{"message":"[gsd-task-result] phase 05 plan 05-08 task Phase05Plan0508Executor failed"}</output>' }],
  }, { cwd });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.planning', '.omp-task-results.json'), 'utf8')), [{ ...result, status: 'failed' }]);
});


test('the state hook and /gsd-status localize progress and blockers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-state-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ response_language: 'Simplified Chinese', mode: 'interactive', hooks: { workflow_guard: true } }));
  const state = (completedPlans) => `---
current_phase: "01"
current_phase_name: execution-foundation
status: executing
progress:
  total_plans: 5
  completed_plans: ${completedPlans}
---

## Current Position

Status: Ready for 01-05-PLAN.md

## Blockers/Concerns

- Verify gateway capability
- Verify secret storage

## Deferred Items
`;
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), state(3));

  const pi = mockPi();
  gsdPiExtension(pi);
  const notices = [];
  const statuses = [];
  const widgets = [];
  const ctx = { cwd, hasUI: true, ui: {
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  assert.match(notices[0].message, /Project State Reminder/);
  assert.deepEqual(statuses[0], { key: 'gsd', text: 'GSD 01 · 项目计划 3/5 · 执行中 ⚠2' });
  assert.deepEqual({
    ...widgets[0],
    lines: widgets[0].lines.map(stripAnsi),
  }, {
    key: 'gsd',
    lines: ['GSD · 需要关注', '└─ ⚠ 2 关注'],
    options: { placement: 'aboveEditor' },
  });
  assert.ok(widgets[0].lines[0].includes(`${ANSI_ESCAPE}[33m`));

  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  const chineseSummary = pi._recorded.messages.at(-1);
  assert.equal(chineseSummary.message.customType, 'gsd-status-summary');
  assert.match(chineseSummary.message.content, /阶段：01 \/ execution-foundation/);
  assert.match(chineseSummary.message.content, /风险：⚠ 2 关注/);

  fs.writeFileSync(configPath, JSON.stringify({ response_language: 'English', hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), state(4));
  await pi._recorded.events.turn_end({}, ctx);
  assert.deepEqual(statuses.at(-1), { key: 'gsd', text: 'GSD 01 · Plans 4/5 · Executing ⚠2' });

  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  const englishSummary = pi._recorded.messages.at(-1);
  assert.match(englishSummary.message.content, /GSD Project Status/);
  assert.match(englishSummary.message.content, /Risks: ⚠ 2 concerns/);
});

test('the GSD console localizes verification-ready state and instruction', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-verification-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'Simplified Chinese' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: ready_for_verification\nprogress:\n total_plans: 5\n completed_plans: 4\n---\n\n## Current Position\n\nStatus: Ready for phase verification\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  const statuses = [];
  const widgets = [];
  const ctx = { cwd, hasUI: true, ui: {
    setStatus: (key, text) => statuses.push({ key, text }),
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  assert.deepEqual(statuses, [{ key: 'gsd', text: 'GSD 01 · 项目计划 4/5 · 待验证' }]);
  assert.deepEqual(widgets[0].lines, []);
});

test('the GSD status line prefers exact phase artifacts over roadmap totals', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-artifacts-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '01-execution-foundation');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  for (const plan of ['01', '02', '03', '04']) {
    fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-PLAN.md`), 'plan');
    fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-SUMMARY.md`), 'summary');
  }
  fs.writeFileSync(path.join(phaseDirectory, '01-PLAN-REVIEW.md'), 'review');
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'Simplified Chinese' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: ready_for_verification\nprogress:\n total_plans: 5\n completed_plans: 4\n---\n');
  const statuses = [];
  await pi._recorded.events.session_start({}, { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } });
  assert.deepEqual(statuses, [{ key: 'gsd', text: 'GSD 01 · 阶段计划 4/4 · 待验证' }]);
  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.match(pi._recorded.messages.at(-1).message.content, /计划：阶段计划 4 \/ 4 已完成/);
});

test('the GSD status counts only summaries matching a phase plan', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-matched-artifacts-'));
  const phaseDirectory = path.join(cwd, '.planning', 'phases', '01-execution-foundation');
  fs.mkdirSync(phaseDirectory, { recursive: true });
  for (const plan of ['01', '02']) fs.writeFileSync(path.join(phaseDirectory, `01-${plan}-PLAN.md`), 'plan');
  fs.writeFileSync(path.join(phaseDirectory, '01-01-SUMMARY.md'), 'summary');
  fs.writeFileSync(path.join(phaseDirectory, '01-99-SUMMARY.md'), 'orphan summary');
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\nprogress:\n total_plans: 2\n completed_plans: 2\n---\n');
  const statuses = [];
  await pi._recorded.events.session_start({}, { cwd, hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } });
  assert.deepEqual(statuses, [{ key: 'gsd', text: 'GSD 01 · Phase plans 1/2 · Executing' }]);
  await pi._recorded.commands['gsd-status'].handler('', { cwd });
  assert.match(pi._recorded.messages.at(-1).message.content, /Plans: Phase plans 1 \/ 2 complete/);

});
test('the first interactive GSD session persists a chosen language once', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-language-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  let promptCount = 0;
  const statuses = [];
  const notices = [];
  const ctx = { cwd, hasUI: true, ui: {
    select: async (_title, options) => {
      promptCount += 1;
      assert.deepEqual(options.map(({ label }) => label), ['简体中文', 'English']);
      return '简体中文';
    },
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
  } };
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);

  assert.equal(promptCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).response_language, 'Simplified Chinese');
  assert.deepEqual(statuses.at(-1), { key: 'gsd', text: 'GSD 01 · 执行中' });
  assert.ok(notices.some(({ message }) => message === 'GSD language set to Simplified Chinese'));
});

test('the language prompt retries after cancellation and tolerates a minimal UI', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-language-retry-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  const selections = [undefined, 'English'];
  const ctx = { cwd, hasUI: true, ui: { select: async () => selections.shift() } };
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  await pi._recorded.events.session_start({}, ctx);
  await new Promise(setImmediate);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).response_language, 'English');
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-second-language-'));
  fs.mkdirSync(path.join(secondCwd, '.planning'));
  const secondConfigPath = path.join(secondCwd, '.planning', 'config.json');
  fs.writeFileSync(secondConfigPath, JSON.stringify({}));
  fs.writeFileSync(path.join(secondCwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  await pi._recorded.events.session_start({}, { cwd: secondCwd, hasUI: true, ui: { select: async () => '简体中文' } });
  await new Promise(setImmediate);
  assert.equal(JSON.parse(fs.readFileSync(secondConfigPath, 'utf8')).response_language, 'Simplified Chinese');
  const minimalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-minimal-ui-'));
  fs.mkdirSync(path.join(minimalCwd, '.planning'));
  fs.writeFileSync(path.join(minimalCwd, '.planning', 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(minimalCwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const minimalPi = mockPi();
  gsdPiExtension(minimalPi);
  await minimalPi._recorded.events.session_start({}, { cwd: minimalCwd, hasUI: true, ui: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(minimalCwd, '.planning', 'config.json'), 'utf8')), {});
});

test('the language selector skips directories that are not GSD projects', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-not-project-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  const pi = mockPi();
  gsdPiExtension(pi);
  let selectCount = 0;
  await pi._recorded.events.session_start({}, {
    cwd,
    hasUI: true,
    ui: { select: async () => { selectCount += 1; return 'English'; } },
  });
  await new Promise(setImmediate);
  assert.equal(selectCount, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {});
});

test('the adapter lifecycle stays inert outside a GSD project', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-lifecycle-gate-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  const pi = mockPi();
  gsdPiExtension(pi);
  const statuses = [];
  const widgets = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget: (key, lines) => widgets.push({ key, lines }),
    },
  };

  await pi._recorded.events.session_start({}, ctx);
  await pi._recorded.events.turn_end({}, ctx);
  const advisory = await pi._recorded.events.tool_call({ toolName: 'edit', input: { path: 'src/app.ts' } }, ctx);
  await pi._recorded.events.tool_result({ content: [{ type: 'text', text: '[checkpoint] phase 01 wave 1/1 plan 01-01 complete (1/1 plans done)' }] }, ctx);

  assert.equal(advisory, undefined);
  assert.deepEqual(statuses, []);
  assert.deepEqual(widgets, []);
  assert.equal(pi._recorded.messages.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.planning', '.omp-checkpoint.json')), false);
});

test('an unresolved language dialog never blocks the session-start handler', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-language-timeout-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  const configPath = path.join(cwd, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  const pi = mockPi();
  gsdPiExtension(pi);
  let resolveSelection;
  const selection = new Promise((resolve) => { resolveSelection = resolve; });
  let sessionStartResolved = false;
  const sessionStart = Promise.resolve(pi._recorded.events.session_start({}, {
    cwd,
    hasUI: true,
    ui: { select: () => selection },
  })).then(() => { sessionStartResolved = true; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStartResolved, true);
  resolveSelection('English');
  await sessionStart;
  await new Promise(setImmediate);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).response_language, 'English');
});
test('the GSD console separates blockers and prepares a safe next step', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-console-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `---
current_phase: "02"
current_phase_name: order-workflow
status: executing
---

## Current Position

Status: Review 02-03-PLAN.md

## Blockers

- Credential-store strategy unresolved

## Concerns

- Testnet access is pending
`);

  const pi = mockPi();
  gsdPiExtension(pi);
  const editor = [];
  const ctx = { cwd, hasUI: true, ui: {
    select: async () => ({ label: 'Prepare next step' }),
    confirm: async () => true,
    setEditorText: (text) => editor.push(text),
  } };
  await pi._recorded.commands['gsd-next'].handler('', ctx);
  assert.equal(editor.length, 0);
  assert.equal(pi._recorded.messages.at(-1).message.customType, 'gsd-next-blocked');
  assert.match(pi._recorded.messages.at(-1).message.content, /⛔ 1 blocker/);
  assert.match(pi._recorded.messages.at(-1).message.content, /⚠ Concern: Testnet access is pending/);

  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `---
current_phase: "02"
status: executing
---

## Current Position

Status: Review 02-03-PLAN.md

## Concerns

- Testnet access is pending
`);
  await pi._recorded.commands['gsd-next'].handler('', ctx);
  assert.deepEqual(editor, ['Review 02-03-PLAN.md']);
});

test('the adapter turns a completed GSD Next Up block into a confirmed new-session handoff', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const output = `
────────────────────────────────────────────────────────────────────────────────

 ▶ Next Up

 Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.

 /clear then:

 /gsd:plan-phase 01 --gaps

 ────────────────────────────────────────────────────────────────────────────────
`;
  const action = gsdPiExtension._internals.extractNextAction(output);
  assert.deepEqual(action, {
    label: 'Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.',
    command: '/gsd:plan-phase 01 --gaps',
    requiresFreshContext: true,
  });
  assert.deepEqual(gsdPiExtension._internals.extractNextAction(output.replace('/gsd:plan-phase', '/gsd-plan-phase')), {
    ...action,
    command: '/gsd-plan-phase 01 --gaps',
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-continuation-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ response_language: 'English' }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: completed\n---\n');
  fs.writeFileSync(path.join(cwd, '.planning', '.omp-next-action.json'), JSON.stringify(action));

  const widgets = [];
  let sessionOptions;
  const ctx = { cwd, hasUI: true, ui: {
    select: async () => ({ label: 'Start new GSD session' }),
    confirm: async () => true,
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
  }, waitForIdle: async () => {}, sessionManager: { getSessionFile: () => '/tmp/old.jsonl' }, newSession: async (options) => { sessionOptions = options; } };
  await pi._recorded.events.session_start({}, ctx);
  assert.deepEqual(widgets[0].lines.map(stripAnsi), [
    'GSD · Next Up',
    '└─ Phase 1 gap closure — plan the metadata-refresh-before-validation boundary.',
    '   /gsd:plan-phase 01 --gaps',
  ]);

  await pi._recorded.commands['gsd-next'].handler('', ctx);
  assert.equal(sessionOptions.parentSession, '/tmp/old.jsonl');
  const setupMessages = [];
  await sessionOptions.setup({ appendMessage: (message) => setupMessages.push(message) });
  assert.match(setupMessages[0].content[0].text, /\/gsd:plan-phase 01 --gaps/);
  assert.match(setupMessages[0].content[0].text, /do not execute it automatically/);
});


test('the workflow guard queues one non-blocking advisory per edited file', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-'));
  fs.mkdirSync(path.join(cwd, '.planning'));
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
  fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');

  const pi = mockPi();
  gsdPiExtension(pi);
  const event = { toolName: 'edit', input: { path: 'src/app.ts' } };
  assert.equal(await pi._recorded.events.tool_call(event, { cwd }), undefined);
  assert.equal(await pi._recorded.events.tool_call(event, { cwd }), undefined);
  assert.equal(pi._recorded.messages.length, 1);
  assert.equal(pi._recorded.messages[0].message.customType, 'gsd-workflow-advisory');
  assert.equal(pi._recorded.messages[0].options.deliverAs, 'nextTurn');
});

test('the workflow guard does not suppress advisories in another GSD project', async () => {
  const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-first-'));
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-guard-second-'));
  for (const cwd of [firstCwd, secondCwd]) {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ hooks: { workflow_guard: true } }));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\ncurrent_phase: "01"\nstatus: executing\n---\n');
  }
  const pi = mockPi();
  gsdPiExtension(pi);
  const event = { toolName: 'edit', input: { path: 'src/app.ts' } };

  await pi._recorded.events.tool_call(event, { cwd: firstCwd });
  await pi._recorded.events.tool_call(event, { cwd: secondCwd });
  await pi._recorded.events.tool_call(event, { cwd: firstCwd });

  assert.equal(pi._recorded.messages.length, 2);
});

test('gsdPiExtension rejects a missing ExtensionAPI', () => {
  assert.throws(() => gsdPiExtension(null), /ExtensionAPI is required/);
});
