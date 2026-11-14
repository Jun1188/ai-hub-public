---
name: aider-studio
description: Use the AI All-In-One Hub Aider tools for high-level local coding work. Trigger when the user asks to use Aider, asks for a local llama.cpp coding agent, or wants Aider to edit a repository from Codex or Antigravity.
---

# Aider Studio

## Bounded extraction instead of delegation

For schema-bound extraction, classification or format conversion over large files, call `offload_run`
(the Hub reads the files and returns only compact results; follow up with `offload_wait`, never a sleep loop).
A `declined` state means local hardware or models cannot take the job: do it yourself.

Use Aider as the coding orchestrator. Do not recreate Aider's planning, repository-map, edit, or commit loop in the host agent.

## Preconditions

1. Read the nearest `AGENTS.md` and repository instructions first.
2. Call `aider_status`.
3. Continue only when Aider and the selected provider report ready; inspect `aider_status`.
4. If the user only asked for analysis, explanation, or diagnosis, do not call `aider_run`.

## Workflow

1. Identify one exact local `project_dir` and a bounded task.
2. Default to `mode: architect` for multi-file changes, `code` for a narrow direct edit, and `ask` for read-only repository questions.
3. Keep `auto_commits: false` unless the user explicitly asks Aider to commit.
4. Call `aider_command_preview` before any editing run. Show or summarize the project, model, mode, file scope, dry-run state, and command.
5. Call `aider_run` only when the user's request authorizes file modification.
6. Poll `aider_result` with the returned `runId` until it reports `completed` or `failed`. Use `aider_cancel` only when the user asks to stop or the task is clearly stuck.
7. Report Aider's exit status and changed-file summary. Never claim a build or test passed unless it was actually run.

## Local model routing

Choose `provider: lmstudio`, `llamacpp`, or `hf-cache` and use a model id returned by
`aider_status`. HF cache profiles prepare llama.cpp on demand. The hub keeps API keys out of
prompts and previews. For local harness workers use a running `lmstudio` or `llamacpp` endpoint.

If the selected provider is not ready, explain the missing layer. Do not silently switch providers.
