'use strict';

/**
 * Project OMP's task-agent contract from GSD's Claude agent source files.
 *
 * Usage: node pi/install-omp-agents.cjs [destination]
 * Default destination: $PI_CODING_AGENT_DIR/agents or ~/.omp/agent/agents.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourceDir = path.resolve(__dirname, '..', 'agents');
const destinationDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'agents');
const ompTools = 'read, write, edit, bash, glob, grep, lsp, web_search, task';

const ompOrchestration = `
## OMP native orchestration

This runtime's native task tool owns subagents, jobs, progress, cancellation, artifacts, and isolation. When a GSD workflow asks to spawn an Agent(...), dispatch a native task instead; never emulate a subagent with shell backgrounding or a hand-written worktree.

- Use a stable task id and operator-facing description: for example Phase02GapPlanner / Create focused Phase 2 repair plans.
- Run independent research, planning, verification, and review work as native task jobs. The OMP Job and Subagents panels are the live progress source; wait for the task result rather than polling or inventing a second status display.
- For executor work that writes repository files, set isolated: true when that field is available. OMP then provisions and cleans the isolated workspace. Never run git worktree yourself.
- If isolated execution is unavailable, stop and report that execution cannot safely proceed. Never write executor changes into the primary checkout as a fallback.
- Research, planning, review, and verification are read-only by default: do not request isolation merely to make them look parallel.
- Preserve GSD's commit, merge, verification, and STATE.md gates. Native task isolation runs work; it does not bypass workflow safety.
`;

function ompResultProtocol(name) {
  if (name !== 'gsd-executor') return '';
  return `
## OMP executor result protocol

The orchestrator reconciles native task results before it updates GSD tracking. Do not report a plan as complete until its required commits and SUMMARY.md have been written.

End the native task's final response with exactly one result line, using the phase, plan, and task id assigned by the orchestrator:

\`\`\`text
[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed
\`\`\`

If execution stops before the plan is complete, emit \`failed\` or \`cancelled\` instead of \`completed\`. The result line is a lifecycle record, not a substitute for GSD's filesystem, merge, verification, or STATE.md gates.
`;
}

function projectAgent(content, sourcePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${sourcePath}`);

  const [, frontmatter, body] = match;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`Missing name or description: ${sourcePath}`);

  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `tools: ${ompTools}`,
    'spawns: "*"',
    '---',
    '',
    body,
    ompOrchestration,
    ompResultProtocol(name),
  ].join('\n');
}

fs.mkdirSync(destinationDir, { recursive: true });
const staged = [];
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^gsd-.*\.md$/.test(entry.name)) continue;
  const sourcePath = path.join(sourceDir, entry.name);
  const targetPath = path.join(destinationDir, entry.name);
  fs.writeFileSync(targetPath, projectAgent(fs.readFileSync(sourcePath, 'utf8'), sourcePath));
  staged.push(targetPath);
}

process.stdout.write(JSON.stringify({ destinationDir, staged: staged.length }) + '\n');
