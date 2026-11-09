import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";

import { ensureFixtureGitMarker } from "../ensure-fixture-git-marker.js";

const fixtureRoot = fixturePath("nested-config-cases");
const aliasImport =
  'src/vs/editor/user.ts\n├── 1: import { HistoryNavigator2 } from "vs/base/history";  [import]';
const aliasUsage = "return new HistoryNavigator2();  [usage]";

class RootExtendsWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), "symnav-nested-config-"));

  constructor() {
    cpSync(fixtureRoot, this.root, { recursive: true });
    rmSync(join(this.root, ".git"), { recursive: true, force: true });
    renameSync(join(this.root, "dot-git"), join(this.root, ".git"));
    writeFileSync(
      join(this.root, "tsconfig.json"),
      JSON.stringify({ extends: "./src/tsconfig.json" }),
    );
  }

  dispose(): void {
    runSymnavBinary(["daemon", "stop"], { cwd: this.root });
    rmSync(this.root, { recursive: true, force: true });
  }
}

let rootExtendsWorkspace: RootExtendsWorkspace;

beforeAll(() => {
  ensureFixtureGitMarker(fixtureRoot);
  rootExtendsWorkspace = new RootExtendsWorkspace();
});

afterAll(() => {
  rootExtendsWorkspace.dispose();
});

describe("symnav refs e2e (tsconfig below the workspace root)", () => {
  it("finds references through a paths alias declared by a nested tsconfig", () => {
    const r = runSymnavBinary(["refs", "HistoryNavigator2"], { cwd: fixtureRoot });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(aliasImport);
    expect(r.stdout).toContain(aliasUsage);
  });

  it("finds the same references through a root tsconfig that extends the nested one", () => {
    const r = runSymnavBinary(["refs", "HistoryNavigator2"], { cwd: rootExtendsWorkspace.root });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(aliasImport);
    expect(r.stdout).toContain(aliasUsage);
  });
});
