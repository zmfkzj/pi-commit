/** Shared, host-independent data contract. No function here mutates Git or disk. */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

/** A hunk from the original snapshot; IDs and hashes remain fixed throughout execution. */
export interface Hunk {
  /** Snapshot-local ID, normally `${path}#${oneBasedOrdinal}`. Treat it as opaque. */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff body lines including their prefix and no-newline markers. */
  lines: string[];
  contentHash: string;
}

export interface FileChange {
  /** Exact repository-relative Git path, not shell-escaped or display-quoted. */
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  binary: boolean;
  isLockfile: boolean;
  untracked: boolean;
  /** The source of the planned content; staged mode ignores unstaged edits. */
  origin: "staged" | "unstaged";
  /** False for whole-file-only changes, including additions, renames and binaries. */
  hunkSplittable: boolean;
  hunks: Hunk[];
}

export interface RepoSnapshot {
  /** If any changes are staged, only the index is planned. Otherwise plan the worktree. */
  mode: "staged" | "worktree";
  files: FileChange[];
  /** null denotes an unborn HEAD. */
  headOid: string | null;
  /** Opaque hash covering HEAD, index and relevant worktree state; checked before writes. */
  fingerprint: string;
  /** Original full diff for each file, keyed by its exact path. */
  diffByFile: Record<string, string>;
  /** Optional canonical repository root supplied by the Git implementation. */
  root?: string;
}

export interface Selector {
  path: string;
  /** 'all' covers the entire file change; arrays name original snapshot hunks. */
  hunks: "all" | string[];
}

export interface CommitMessage {
  subject: string;
  body?: string;
}

export interface CommitGroup {
  id: string;
  message: CommitMessage;
  selectors: Selector[];
  /** Group IDs that must be committed first, not file paths. */
  dependsOn: string[];
  /** Optional human-readable entry merged into the generated changelog preview. */
  changelogEntry?: string;
}

/** A fully previewable proposed write. null means the file does not yet exist. */
export interface ChangelogChange {
  file: string;
  newContent: string;
  originalContent: string | null;
}

export interface CommitPlan {
  groups: CommitGroup[];
  /** Generated content must never be written until explicit authorization. */
  changelog?: ChangelogChange;
}

export interface PlanValidationError {
  code: string;
  message: string;
  groupId?: string;
  path?: string;
  hunkId?: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  /** Stable topological order; empty on invalid input. */
  orderedGroups: CommitGroup[];
}

/** Minimal portable messages for deterministic mock models and real provider adapters. */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ModelTool {
  name: string;
  description: string;
  /** JSON schema; adapters may convert it to their provider's tool schema. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelResponse {
  text: string;
  toolCalls?: ModelToolCall[];
}

/** Failure rejects; no implementation may manufacture a fallback commit plan. */
export interface ModelAdapter {
  complete(
    messages: ModelMessage[],
    tools?: ModelTool[],
    options?: { signal?: AbortSignal },
  ): Promise<ModelResponse>;
}

export interface SucceededCommit {
  oid: string;
  groupId: string;
}

/** Partial success is permanent: never reset committed history to hide a failure. */
export interface ExecutionResult {
  succeeded: SucceededCommit[];
  failedGroup?: string;
  error?: string;
  /** Uncommitted group IDs, including the failed group. */
  remainingGroups: string[];
  /** Whether the original index was restored after a pre-commit failure. */
  restoredIndex: boolean;
  /** Whether generated changelog writes were restored after a pre-commit failure. */
  changelogRestored: boolean;
}
