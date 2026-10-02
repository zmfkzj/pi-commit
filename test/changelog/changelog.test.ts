import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChangelogPreview, detectChangelog, readChangelog } from "../../src/changelog/index.js";

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "pi-commit-changelog-")); temps.push(root); return root; }

describe("pure insertion-only changelog preview", () => {
  test("creates a new Keep-a-Changelog file", () => {
    const result = buildChangelogPreview("CHANGELOG.md", null, ["Added: Parser", "Fixed: Crash"]);
    expect(result.originalContent).toBeNull();
    expect(result.newContent).toBe("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Parser\n\n### Fixed\n\n- Crash\n\n");
  });
  test("merges matching category and preserves original bytes everywhere else", () => {
    const original = "# Changes\r\n\r\nIntro stays  \r\n\r\n## [Unreleased]\r\n\r\n### Fixed\r\n\r\n- Old crash.\r\n\r\n## [1.0] - 2026-01-01\r\n\r\n### Added\r\n- Historic\r\n\r\n[1.0]: link\r\n";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["Fixed: New crash"]);
    const insertion = "\r\n- New crash\r\n";
    expect(result.newContent.replace(insertion, "")).toBe(original);
    expect(result.newContent.slice(result.newContent.indexOf("## [1.0]"))).toBe(original.slice(original.indexOf("## [1.0]")));
    expect(result.originalContent).toBe(original);
  });
  test("dedupes case, bullet prefixes, terminal periods and repeated proposal entries", () => {
    const original = "# Changelog\n\n## [Unreleased]\n\n### Changed\n- Parser fixed.\n";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["parser FIXED", "- Parser fixed.", "Other entry", "OTHER ENTRY."]);
    expect(result.newContent.match(/- Other entry/g)).toHaveLength(1);
    expect(result.newContent).not.toContain("- parser FIXED");
    expect(buildChangelogPreview("CHANGELOG.md", original, ["parser fixed"]).newContent).toBe(original);
  });
  test("entries in old releases do not suppress new Unreleased changes", () => {
    const original = "# Changelog\n\n## [1.0]\n- Parser fixed\n";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["Parser fixed"]);
    expect(result.newContent.match(/- Parser fixed/g)).toHaveLength(2);
    expect(result.newContent.endsWith("## [1.0]\n- Parser fixed\n")).toBe(true);
  });
  test("creates missing Unreleased section before first version, preserving all original text", () => {
    const original = "# Log\n\nIntro\n\n## [1.2]\n\nOriginal\n";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["Change"]);
    const prefix = original.slice(0, original.indexOf("## [1.2]"));
    expect(result.newContent.startsWith(prefix + "## [Unreleased]\n")).toBe(true);
    expect(result.newContent.endsWith(original.slice(original.indexOf("## [1.2]")))).toBe(true);
  });
  test("new category preserves custom category and unbracketed Unreleased", () => {
    const original = "# Log\n\n## Unreleased\n\n### Custom\ncustom text\n\n## 1.0\nold\n";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["Security: Safer parsing"]);
    expect(result.newContent).toContain("### Security\n\n- Safer parsing");
    expect(result.newContent).toContain("### Custom\ncustom text\n");
    expect(result.newContent.endsWith("## 1.0\nold\n")).toBe(true);
  });
  test("EOF without newline and empty changelog handled", () => {
    expect(buildChangelogPreview("CHANGELOG.md", "## [Unreleased]", ["Change"]).newContent).toContain("## [Unreleased]\n\n### Changed");
    expect(buildChangelogPreview("CHANGELOG.md", "", ["Change"]).newContent.startsWith("## [Unreleased]\n")).toBe(true);
    expect(buildChangelogPreview("CHANGELOG.md", "# Changelog", ["Change"]).newContent).toContain("# Changelog\n\n## [Unreleased]");
  });
  test("no entries means no content changes", () => {
    expect(buildChangelogPreview("CHANGELOG.md", "original", []).newContent).toBe("original");
    expect(buildChangelogPreview("CHANGELOG.md", null, []).newContent).toBe("");
  });
  test("unsafe paths and multiline/control entries refused", () => {
    expect(() => buildChangelogPreview("../CHANGELOG.md", null, ["change"])).toThrow("Unsafe");
    for (const entry of ["bad\nentry", "bad\x1bentry", "bad\0entry"]) expect(() => buildChangelogPreview("CHANGELOG.md", null, [entry])).toThrow("safe lines");
  });
  test("coalesces additions at EOF without moving entries under the wrong category", () => {
    const original = "## [Unreleased]\n\n### Fixed";
    const result = buildChangelogPreview("CHANGELOG.md", original, ["Added: New parser", "Fixed: Crash"]);
    expect(result.newContent.indexOf("- Crash")).toBeLessThan(result.newContent.indexOf("### Added"));
    expect(result.newContent.indexOf("- New parser")).toBeGreaterThan(result.newContent.indexOf("### Added"));
    expect(result.newContent.startsWith(original)).toBe(true);
  });
});

describe("read-only changelog discovery", () => {
  test("finds case variants and prefers canonical root file, no writes", async () => {
    const root = await temp();
    expect(await detectChangelog(root)).toBeNull();
    await writeFile(join(root, "changelog.md"), "lower");
    expect(await detectChangelog(root)).toEqual({ file: "changelog.md", content: "lower" });
    await writeFile(join(root, "CHANGELOG.md"), "canonical\r\n");
    expect(await detectChangelog(root)).toEqual({ file: "CHANGELOG.md", content: "canonical\r\n" });
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("canonical\r\n");
  });
  test("symlink targets and invalid UTF-8 rejected, missing file returns null", async () => {
    const root = await temp(); const other = await temp();
    await writeFile(join(other, "outside"), "private");
    await symlink(join(other, "outside"), join(root, "CHANGELOG.md"));
    await expect(detectChangelog(root)).rejects.toThrow("symlink");
    await rm(join(root, "CHANGELOG.md"));
    await writeFile(join(root, "CHANGELOG.md"), Buffer.from([0xff, 0xfe]));
    await expect(detectChangelog(root)).rejects.toThrow("UTF-8");
    expect(await readChangelog(root, "missing.md")).toBeNull();
    await expect(readChangelog(root, "../outside")).rejects.toThrow("Unsafe");
  });
});
