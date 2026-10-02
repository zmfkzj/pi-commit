# Third-party notices

## oh-my-pi (MIT)

Repository: https://github.com/can1357/oh-my-pi

Pinned revision: `2a7db746ff9774180e2f81cc1f3fdd8c925269be`

License fetched independently from:
https://raw.githubusercontent.com/can1357/oh-my-pi/2a7db746ff9774180e2f81cc1f3fdd8c925269be/LICENSE

Verified SHA-256: `16c45f9d667442781f03fa198914cc39abcaa48ec5ed8f644643e554ca2fbf63`

Adaptations (not wholesale vendoring):

- `src/plan/planner.ts`: workflow/prompt concepts from
  `packages/coding-agent/src/commit/agentic/prompts/system.md` and
  `packages/coding-agent/src/commit/agentic/agent.ts`. Read-only snapshot JSON
  views and bounded validated responses replace native agent/subagent tools.
- `src/plan/validate.ts`: dependency sorting, manifest/lockfile mappings and
  validation concepts from
  `packages/coding-agent/src/commit/agentic/topo-sort.ts`,
  `packages/coding-agent/src/commit/agentic/lock-files.ts`, and
  `packages/coding-agent/src/commit/agentic/tools/split-commit.ts`.
- `src/changelog/index.ts`: detection, section merge and deduplication concepts
  from `packages/coding-agent/src/commit/changelog/detect.ts`,
  `packages/coding-agent/src/commit/changelog/parse.ts`, and
  `packages/coding-agent/src/commit/changelog/generate.ts`.

Each adapted source file also carries the complete upstream notice below and
its pinned source-path attribution. The Git engine is an independent TypeScript
implementation, replacing the native Rust staging backend. No conventional,
legacy llm-git, cache or fallback-commit implementation was reused.

### Original upstream license (verbatim)

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Host-provided Pi APIs

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are host-provided
peer dependencies, not bundled source copies. This package was checked against
both packages at version `1.0.0`. Their own distributions retain their licenses.
