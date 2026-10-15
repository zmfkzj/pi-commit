# Changelog

## [Unreleased]

### Added

- `/commit doctor` checks pi-commit's runtime prerequisites read-only (Git ≥ 2.31 on PATH, a Git author/committer identity for the current directory, whether the current directory is a Git work tree, a selected planning model with credentials configured) and says what to do for each problem; `/commit install-deps` reports the same requirements as manual steps (pi-commit has no npm runtime dependencies and never installs Git or writes `git config`). Both are offered as first-word completions, take no arguments, and answer the umbrella's `/oh-my-pi doctor|install-deps` through the `oh-my-pi-extensions:dependencies` event channel (`src/dependencies.ts`). Existing `/commit` input keeps its meaning: bare words were always rejected, and `--context doctor` is still a planning instruction.
- `/commit` now prints a start message (`pi-commit: analyzing changes and planning commits…`) right after the arguments are parsed, so you can see it started while the model plans.
- `/commit` now offers argument completions for its options (`--dry-run`, `--model`, `--context`, `--no-changelog`, `--push`, `--yes`, `--help`); options already given are not offered again, and nothing is offered while a value, a quoted string or an escape is being typed.

### Fixed

- `/commit` previews of large diffs no longer crash the TUI (`Maximum call stack size exceeded` in Markdown rendering); `/commit` output is now rendered as plain text instead of Markdown.
- `/commit --push` no longer freezes the TUI on a Git credential prompt (`Username for 'https://github.com':`): the push runs non-interactively (terminal prompts disabled, no controlling terminal), so missing credentials fail at once while credential helpers, askpass programs and ssh-agent keys still work. A failed push now says the commits were created locally, shows Git's reason and, for authentication failures, how to set up non-interactive auth.

### Changed

- Development and tests run on Pi 1.2.0: `@earendil-works/pi-coding-agent`, `pi-ai` and `pi-tui` devDependencies 1.0.0 → 1.2.0 (`bun.lock` updated, which now also lists `pi-tui`); the `*` peer ranges are unchanged and no code changed.

- Raised the default commit planning timeout from 120 to 300 seconds.
- A committing `/commit` run no longer prints the file-level plan summary to the transcript; the result lists each new commit as its short hash and message (`Committed N commits:`) instead of group IDs and full hashes. The plan summary is still shown by `--dry-run`, in the confirmation dialog and when writes are refused, and failure output keeps full hashes, the failed/remaining groups and the error.

- The plan shown by `--dry-run`, the confirmation dialog and `--yes` no longer includes any diffs (hunk lines, whole-file diffs or the changelog diff); it is now a compact commit plan summary with groups, messages, dependencies, files, selected hunks and the changelog target.
- `--yes` now skips the confirmation dialog in every mode after showing the plan summary; `--dry-run` still never writes.
- Large change sets use less model context, and the evidence-limit error now lists the largest files and how to stage a subset.

- --push now refuses to push when referenced submodule commits are not on the submodule remote, and still never pushes submodules automatically.

