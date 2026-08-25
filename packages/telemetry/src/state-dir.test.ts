import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStateDir, usageLogPath } from "./state-dir.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveStateDir", () => {
  it("uses SYMNAV_STATE_DIR when set", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-state-dir-"));
    temporaryDirectories.push(root);

    expect(resolveStateDir({ SYMNAV_STATE_DIR: join(root, "state") }, "/unused")).toBe(
      join(realpathSync(root), "state"),
    );
  });

  it("uses the homedir symnav directory when SYMNAV_STATE_DIR is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-state-dir-"));
    temporaryDirectories.push(root);

    expect(resolveStateDir({}, root)).toBe(join(realpathSync(root), ".symnav"));
  });

  it("canonicalizes relative and dot-segment state directories", () => {
    expect(resolveStateDir({ SYMNAV_STATE_DIR: "state/../state" })).toBe(resolve("state"));
  });

  it("canonicalizes a symlinked state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-state-dir-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    const symlink = join(root, "state-link");
    mkdirSync(target);
    symlinkSync(target, symlink, process.platform === "win32" ? "junction" : "dir");

    expect(resolveStateDir({ SYMNAV_STATE_DIR: symlink })).toBe(realpathSync(target));
  });

  it("keeps an already canonical state directory unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-state-dir-"));
    temporaryDirectories.push(root);
    const canonicalRoot = realpathSync(root);

    expect(resolveStateDir({ SYMNAV_STATE_DIR: canonicalRoot })).toBe(canonicalRoot);
  });
});

describe("usageLogPath", () => {
  it("places usage.jsonl under the state directory", () => {
    expect(usageLogPath("/state")).toBe(join("/state", "usage.jsonl"));
  });
});
