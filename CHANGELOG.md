# Changelog

## [Unreleased]

### Added

- `/commit` now prints a start message (`pi-commit: analyzing changes and planning commits…`) right after the arguments are parsed, so you can see it started while the model plans.

### Fixed

- `/commit` previews of large diffs no longer crash the TUI (`Maximum call stack size exceeded` in Markdown rendering); `/commit` output is now rendered as plain text instead of Markdown.

### Changed

- Raised the default commit planning timeout from 120 to 300 seconds.

- The plan shown by `--dry-run`, the confirmation dialog and `--yes` no longer includes any diffs (hunk lines, whole-file diffs or the changelog diff); it is now a compact commit plan summary with groups, messages, dependencies, files, selected hunks and the changelog target.
- `--yes` now skips the confirmation dialog in every mode after showing the plan summary; `--dry-run` still never writes.
- Large change sets use less model context, and the evidence-limit error now lists the largest files and how to stage a subset.

- --push now refuses to push when referenced submodule commits are not on the submodule remote, and still never pushes submodules automatically.

