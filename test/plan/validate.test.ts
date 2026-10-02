import { describe, expect, test } from "bun:test";
import { isSafeRepoPath, validatePlan } from "../../src/plan/validate.js";
import { file, group, plan, snapshot } from "./fixtures.js";

const codes = (proposal: unknown, snap = snapshot()) => validatePlan(proposal, snap).errors.map(error => error.code);

describe("complete and stable commit plan validation", () => {
  test("valid single commit", () => { expect(validatePlan(plan(), snapshot()).valid).toBe(true); });
  test("same file split across two distinct hunks", () => {
    const proposal = plan([group("g1", "src/a.ts", ["src/a.ts#1"]), group("g2", "src/a.ts", ["src/a.ts#2"], ["g1"])]);
    expect(validatePlan(proposal, snapshot()).orderedGroups.map(group => group.id)).toEqual(["g1", "g2"]);
  });
  test("stable topological order chooses earliest available original group", () => {
    const proposal = plan([group("g1", "a", "all", ["g2"]), group("g2", "b"), group("g3", "c")]);
    expect(validatePlan(proposal, snapshot([file("a"), file("b"), file("c")])).orderedGroups.map(group => group.id)).toEqual(["g2", "g1", "g3"]);
  });
  test("shape failure never throws", () => {
    for (const input of [null, undefined, [], { groups: [null] }, { groups: [42] }, { groups: [{ message: {} }] }, { ...plan(), shell: "git add" }]) expect(codes(input)).toContain("invalid_shape");
  });
  test("empty plans/groups/selectors invalid", () => {
    expect(codes(plan([]))).toContain("empty_plan");
    expect(codes(plan([{ ...group(), selectors: [] }]))).toContain("empty_group");
    expect(codes(plan([group("g1", "src/a.ts", [])]))).toContain("empty_selector");
  });
  test("unknown path and unknown hunk rejected", () => {
    expect(codes(plan([group("g1", "outside")]))).toContain("unknown_path");
    expect(codes(plan([group("g1", "src/a.ts", ["src/a.ts#3"])]))).toContain("unknown_hunk");
  });
  test("hunk IDs must belong to selected file", () => {
    expect(codes(plan([group("g1", "src/a.ts", ["src/b.ts#1"])]))).toContain("unknown_hunk");
  });
  test("missing file/hunk coverage rejected", () => {
    expect(codes(plan([group("g1", "src/a.ts", ["src/a.ts#1"])]))).toContain("missing_coverage");
    expect(codes(plan(), snapshot([file("src/a.ts"), file("other")]))).toContain("missing_coverage");
  });
  test("overlap across whole-file and hunk/group boundaries rejected", () => {
    expect(codes(plan([group(), group("g2")]))).toContain("overlap");
    expect(codes(plan([group(), group("g2", "src/a.ts", ["src/a.ts#2"])]))).toContain("overlap");
    expect(codes(plan([group("g1", "src/a.ts", ["src/a.ts#1", "src/a.ts#1", "src/a.ts#2"])]))).toContain("overlap");
  });
  test("duplicate ids, unknown/self deps and cycles rejected", () => {
    expect(codes(plan([group(), group()]))).toContain("duplicate_group");
    expect(codes(plan([group("g1", "src/a.ts", "all", ["missing"])]))).toContain("unknown_dependency");
    expect(codes(plan([group("g1", "src/a.ts", "all", ["g1"])]))).toContain("self_dependency");
    const proposal = plan([group("a", "x", "all", ["b"]), group("b", "y", "all", ["a"])]);
    const result = validatePlan(proposal, snapshot([file("x"), file("y")]));
    expect(result.errors.map(error => error.code)).toContain("dependency_cycle");
    expect(result.orderedGroups).toEqual([]);
  });
  test("invalid subjects/bodies and entries rejected", () => {
    for (const subject of ["", " ", "a".repeat(73), "bad\nsubject", "bad\x1bsubject", "bad\x7fsubject"]) expect(codes(plan([{ ...group(), message: { subject } }]))).toContain("invalid_message");
    expect(validatePlan(plan([{ ...group(), message: { subject: "수정".repeat(36), body: "First\nSecond" } }]), snapshot()).valid).toBe(true);
    expect(codes(plan([{ ...group(), message: { subject: "Fix", body: "\0" } }]))).toContain("invalid_message");
    expect(codes(plan([{ ...group(), changelogEntry: "bad\nentry" }]))).toContain("invalid_changelog_entry");
  });
  test("unsafe path selectors rejected, unusual legitimate snapshot paths preserved", () => {
    for (const path of ["../a", "/etc/passwd", "./a", "foo/../../a", "C:\\a", "foo\\..\\a", ".git/config", "foo/.GIT/config", "a\0b", "a//b"]) {
      expect(isSafeRepoPath(path)).toBe(false);
      expect(codes(plan([group("g1", path)]))).toContain("unsafe_path");
    }
    for (const path of ["space name.ts", "quote\"name.ts", "한글.ts", "line\nname.ts", "back\\slash.ts", "-flag.ts"]) expect(validatePlan(plan([group("g1", path)]), snapshot([file(path)])).valid).toBe(true);
  });
  test("whole file constraint for new/deleted/renamed/binary/mode-only changes", () => {
    for (const status of ["added", "deleted", "renamed", "typechange"] as const) {
      const snap = snapshot([file("src/a.ts", { status, hunkSplittable: false })]);
      expect(codes(plan([group("g1", "src/a.ts", ["src/a.ts#1"])]), snap)).toContain("whole_file_required");
      expect(validatePlan(plan(), snap).valid).toBe(true);
    }
    expect(codes(plan([group("g1", "src/a.ts", ["src/a.ts#1"])]), snapshot([file("src/a.ts", { binary: true, hunkSplittable: false, hunks: [] })]))).toContain("whole_file_required");
  });
  test("unsafe/changing changelog rejected without mutation", () => {
    expect(codes({ ...plan(), changelog: { file: "../CHANGELOG.md", originalContent: null, newContent: "new" } })).toContain("invalid_changelog");
    expect(codes({ ...plan(), changelog: { file: "src/a.ts", originalContent: "original", newContent: "new" } })).toContain("changelog_overlap");
    expect(validatePlan({ ...plan(), changelog: { file: "CHANGELOG.md", originalContent: null, newContent: "new" } }, snapshot()).valid).toBe(true);
  });
});

describe("explicit deterministic lockfile grouping", () => {
  const snap = snapshot([file("package.json"), file("package-lock.json", { isLockfile: true }), file("src/a.ts")]);
  const manifest = { ...group("deps", "package.json"), selectors: [{ path: "package.json", hunks: "all" as const }, { path: "package-lock.json", hunks: "all" as const }] };
  test("lockfile shares changed manifest group", () => { expect(validatePlan(plan([manifest, group("code")]), snap).valid).toBe(true); });
  test("lockfile in unrelated group rejected", () => { expect(codes(plan([group("deps", "package.json"), { ...group("code"), selectors: [{ path: "src/a.ts", hunks: "all" }, { path: "package-lock.json", hunks: "all" }] }]), snap)).toContain("lockfile_group"); });
  test("unpaired lockfile requires dedicated lockfile-only group", () => {
    const orphan = snapshot([file("package-lock.json", { isLockfile: true }), file("src/a.ts")]);
    expect(validatePlan(plan([group("deps", "package-lock.json"), group("code")]), orphan).valid).toBe(true);
    expect(codes(plan([{ ...group(), selectors: [{ path: "package-lock.json", hunks: "all" }, { path: "src/a.ts", hunks: "all" }] }]), orphan)).toContain("lockfile_group");
  });
  test("paired manifest split is ambiguous and rejected", () => {
    const proposal = plan([{ ...manifest, selectors: [{ path: "package.json", hunks: ["package.json#1"] }, { path: "package-lock.json", hunks: "all" }] }, group("other", "package.json", ["package.json#2"]), group("code")]);
    expect(codes(proposal, snap)).toContain("lockfile_group");
  });
  test("lockfiles themselves may not be hunk split", () => { expect(codes(plan([group("deps", "package-lock.json", ["package-lock.json#1", "package-lock.json#2"])]), snapshot([file("package-lock.json", { isLockfile: true })]))).toContain("whole_file_required"); });
  test("sibling takes precedence over lexical remote manifest", () => {
    const snap = snapshot([file("a/package.json"), file("z/package.json"), file("z/yarn.lock", { isLockfile: true })]);
    expect(validatePlan(plan([group("a", "a/package.json"), { ...group("z", "z/package.json"), selectors: [{ path: "z/package.json", hunks: "all" }, { path: "z/yarn.lock", hunks: "all" }] }]), snap).valid).toBe(true);
  });
  test("validation is pure", () => { const proposal = plan([manifest, group("code")]); const before = JSON.stringify([proposal, snap]); validatePlan(proposal, snap); expect(JSON.stringify([proposal, snap])).toBe(before); });
});
