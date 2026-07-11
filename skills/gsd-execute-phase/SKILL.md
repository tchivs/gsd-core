---
name: gsd-execute-phase
description: "Execute all plans in a phase with wave-based parallelization"
argument-hint: "<phase-number> [--wave N] [--gaps-only] [--interactive] [--tdd]"
effort: max
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - TodoWrite
  - AskUserQuestion
---

<objective>
Execute all plans in a phase using wave-based parallel execution.

Orchestrator stays lean: discover plans, analyze dependencies, group into waves, spawn subagents, collect results. Each subagent loads the full execute-plan context and handles its own plan.

Optional wave filter:
- `--wave N` executes only Wave `N` for pacing, quota management, or staged rollout
- phase verification/completion still only happens when no incomplete plans remain after the selected wave finishes

Flag handling rule:
- The optional flags documented below are available behaviors, not implied active behaviors
- A flag is active only when its literal token appears in `$ARGUMENTS`
- If a documented flag is absent from `$ARGUMENTS`, treat it as inactive

Context budget: ~15% orchestrator, 100% fresh per subagent.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-phase.md
@~/.claude/gsd-core/references/ui-brand.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API.
</runtime_note>

<omp_native_execution>
**OMP:** Native `task` is the executor primitive. Replace every `Agent(...)` dispatch in the execution workflow with a native `task` dispatch; do not fall back to inline execution merely because Claude's `Agent` API is absent.

- Create one task per plan. A parallel wave is one native task batch; wait for all task results before progressing to the next wave.
- Use stable executor IDs: `Phase{PHASE}Plan{PLAN}Executor`; use operator-facing descriptions such as `Execute Phase 05 plan 05-08`.
- Supply the executor role, complete plan assignment, GSD context paths, and all existing executor acceptance criteria in every task.
- For a task that writes repository files, set `isolated: true`. If isolation is unavailable, stop before dispatch; do not edit the primary checkout as a substitute.
- Read-only research, review, and verification tasks remain non-isolated.
- Treat a native task result as a lifecycle signal only. Before marking a plan complete, preserve the workflow's required SUMMARY.md, commit, merge, post-wave test, and STATE.md gates.
- Require every executor final response to end with `[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed`, or `failed` / `cancelled`. OMP records this independently of the progress checkpoint.
- Never invoke `git worktree` yourself. OMP owns isolation setup and cleanup.
</omp_native_execution>

<context>
Phase: $ARGUMENTS

**Available optional flags (documentation only — not automatically active):**
- `--wave N` — Execute only Wave `N` in the phase. Use when you want to pace execution or stay inside usage limits.
- `--gaps-only` — Execute only gap closure plans (plans with `gap_closure: true` in frontmatter). Use after verify-work creates fix plans.
- `--interactive` — Execute plans sequentially inline (no subagents) with user checkpoints between tasks. Lower token usage, pair-programming style. Best for small phases, bug fixes, and verification gaps.

**Active flags must be derived from `$ARGUMENTS`:**
- `--wave N` is active only if the literal `--wave` token is present in `$ARGUMENTS`
- `--gaps-only` is active only if the literal `--gaps-only` token is present in `$ARGUMENTS`
- `--interactive` is active only if the literal `--interactive` token is present in `$ARGUMENTS`
- If none of these tokens appear, run the standard full-phase execution flow with no flag-specific filtering
- Do not infer that a flag is active just because it is documented in this prompt

Context files are resolved inside the workflow via `gsd-tools query init.execute-phase` and per-subagent `<files_to_read>` blocks.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (wave execution, checkpoint handling, verification, state updates, routing).
</process>
