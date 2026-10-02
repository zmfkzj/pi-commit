import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  allowFailure?: boolean;
}
export interface GitResult { stdout: Buffer; stderr: Buffer; code: number }

/** Argument arrays only. Disable optional index refresh and inherited alternate-index state. */
export async function git(root: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }, options.env);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=true", ...args], { cwd: root, env, stdio: "pipe" });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => { /* An early Git exit closes stdin. */ });
    child.on("close", (code) => {
      const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? -1 };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.toString("utf8").trim()}`));
      } else resolve(result);
    });
    child.stdin.end(options.input);
  });
}

export function digest(...parts: (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) { const bytes = Buffer.from(part); hash.update(String(bytes.length)); hash.update(":"); hash.update(bytes); }
  return hash.digest("hex");
}
export function lineOutput(bytes: Buffer): string { return bytes.toString("utf8").replace(/\n$/, ""); }
export function nulPaths(bytes: Buffer): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.split("\0").filter(Boolean);
}
