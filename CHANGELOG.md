# Changelog

## [Unreleased]

### Changed

- `--yes` now skips the confirmation dialog in every mode after showing the full preview; `--dry-run` still never writes.
- Large change sets use less model context, and the evidence-limit error now lists the largest files and how to stage a subset.

- --push now refuses to push when referenced submodule commits are not on the submodule remote, and still never pushes submodules automatically.

