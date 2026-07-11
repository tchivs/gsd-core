'use strict';

/**
 * Adds OMP-native execution semantics to the generated GSD skill files that
 * OMP discovers from its global agent directory.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OMP_SKILL_BLOCKS = {
  'gsd-execute-phase': `<omp_native_execution>
**OMP:** Native \`task\` is the executor primitive. Replace every \`Agent(...)\` dispatch in the execution workflow with a native \`task\` dispatch; do not fall back to inline execution merely because Claude's \`Agent\` API is absent.

- Create one task per plan. A parallel wave is one native task batch; wait for all task results before progressing to the next wave.
- Use stable executor IDs: \`Phase{PHASE}Plan{PLAN}Executor\`; use operator-facing descriptions such as \`Execute Phase 05 plan 05-08\`.
- Treat a native task result as a lifecycle signal only. Before marking a plan complete, preserve the workflow's required SUMMARY.md, commit, merge, post-wave test, and STATE.md gates.
- Require every executor final response to end with \`[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed\`, or \`failed\` / \`cancelled\`. OMP records this independently of the progress checkpoint.
- Never invoke \`git worktree\` yourself. OMP owns isolation setup and cleanup.
</omp_native_execution>`,
  'gsd-progress': `<omp_artifact_handling>
**OMP:** \`.planning/debug/\` and \`.planning/todos/pending/\` are optional. Their absence means zero active debug sessions and zero pending todo artifacts; do not emit an error or invoke Glob/Grep with either missing directory as its root. When checking optional artifacts, scan an existing \`.planning\` root and filter matching paths. A truncated summary glob may supply recent-work examples only; never use it to derive plan or summary counts.
</omp_artifact_handling>`,
};

function installOmpSkills(skillsDir, sourceSkillsDir = path.resolve(__dirname, '..', 'skills')) {
  const installed = [];
  for (const [name, block] of Object.entries(OMP_SKILL_BLOCKS)) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      const sourceSkillPath = path.join(sourceSkillsDir, name, 'SKILL.md');
      if (!fs.existsSync(sourceSkillPath)) continue;
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.copyFileSync(sourceSkillPath, skillPath);
    }
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf8');
    if (content.includes(block)) {
      installed.push(skillPath);
      continue;
    }
    const marker = content.includes('<context>') ? '<context>' : '<process>';
    const index = content.indexOf(marker);
    if (index < 0) throw new Error(`Missing ${marker} in ${skillPath}`);
    fs.writeFileSync(skillPath, `${content.slice(0, index)}${block}\n\n${content.slice(index)}`);
    installed.push(skillPath);
  }
  return installed;
}

if (require.main === module) {
  const skillsDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'skills');
  const installed = installOmpSkills(skillsDir, path.resolve(__dirname, '..', 'skills'));
  process.stdout.write(JSON.stringify({ skillsDir, installed: installed.length }) + '\n');
}

module.exports = { installOmpSkills };
