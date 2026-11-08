import { join } from "node:path";
import { checkPushTarget } from "./executor.js";
import { git, lineOutput, nulPaths } from "./process.js";
import { initializedSubmodules } from "./snapshot.js";

/** A repository to push, by its path relative to the top-level repository ("" for it) and its absolute root. */
export interface PushTarget { path: string; root: string }

/**
 * Submodule commits that pushing `root`'s current branch would send references to: the new side of every gitlink change
 * in the commits that are not yet on the upstream remote's remote-tracking refs (the commit range Git's
 * `push --recurse-submodules=check` inspects). Gitlink path -> OIDs. Read-only.
 */
async function referencedSubmoduleCommits(root: string, remote: string): Promise<Map<string, Set<string>>> {
  const referenced = new Map<string, Set<string>>();
  const range = await git(root, ["rev-list", "HEAD", "--not", `--remotes=${remote}`], { allowFailure: true });
  const commits = range.code === 0 ? range.stdout : Buffer.alloc(0); // unborn HEAD: nothing to push
  if (!commits.length) return referenced;
  const raw = nulPaths((await git(root, ["diff-tree", "--stdin", "-r", "-z", "-m", "--root", "--no-renames", "--no-commit-id", "--ignore-submodules=none"], { input: commits })).stdout);
  for (let index = 0; index + 1 < raw.length; index++) {
    const header = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(raw[index]!);
    if (!header) continue;
    const path = raw[++index]!;
    if (header[1] === "160000" && header[3] !== "D") (referenced.get(path) ?? referenced.set(path, new Set()).get(path)!).add(header[2]!);
  }
  return referenced;
}

/**
 * Already-committed submodules (recursively) that must be pushed before `root` can be: a checked-out submodule is needed
 * when it has a commit referenced by `root`'s unpublished commits, or by `planned` (gitlink path -> the OID a commit of
 * this run will record), that is on none of its remote-tracking refs. This is exactly what Git's
 * `--recurse-submodules=check` would refuse; commits a submodule does not have are skipped, as Git does. Each needed
 * submodule's own needs come before it. Roots in `skip` (pushed anyway, e.g. committed in this run) are not repeated;
 * returned roots are added to it. When `root` itself has no valid push target (its push is refused in the preflight),
 * its unpublished history has no defined range, so only `planned` is checked: that still routes a run that would publish
 * submodules through the preflight, which then refuses before any commit. Read-only.
 */
export async function unpublishedSubmodules(root: string, path: string, planned: ReadonlyMap<string, string>, skip: Set<string>): Promise<PushTarget[]> {
  let referenced = new Map<string, Set<string>>();
  const target = await checkPushTarget(root).catch(() => undefined);
  if (target) referenced = await referencedSubmoduleCommits(root, target.remote);
  for (const [child, oid] of planned) (referenced.get(child) ?? referenced.set(child, new Set()).get(child)!).add(oid);
  if (!referenced.size) return [];
  const submodules = new Set(await initializedSubmodules(root)), needed: PushTarget[] = [];
  for (const [child, oids] of [...referenced].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const childRoot = join(root, child), childPath = path ? `${path}/${child}` : child;
    if (!submodules.has(child) || skip.has(childRoot)) continue;
    const check = (await git(childRoot, ["cat-file", "--batch-check"], { input: [...oids].map(oid => `${oid}^{commit}\n`).join("") })).stdout.toString("utf8");
    const present = check.split("\n").filter(line => / commit \d+$/.test(line)).map(line => line.slice(0, line.indexOf(" ")));
    if (!present.length) continue;
    const unpublished = lineOutput((await git(childRoot, ["rev-list", "-n", "1", ...present, "--not", "--remotes"])).stdout);
    if (!unpublished) continue;
    skip.add(childRoot);
    needed.push(...await unpublishedSubmodules(childRoot, childPath, new Map(), skip), { path: childPath, root: childRoot });
  }
  return needed;
}
