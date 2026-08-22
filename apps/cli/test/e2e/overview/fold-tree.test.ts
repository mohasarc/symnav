import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runOverview } from "./run-overview.js";

describe("symnav overview e2e (fold tree)", () => {
  it("renders folded call headers without opening them at depth zero", async () => {
    const r = runOverview(["overview", "fold-tree.ts", "--depth", "0"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-5: describe("x", () => {');
    expect(r.stdout).not.toContain("2-4: helper");
    expect(r.stdout).not.toContain("2 const helper = () => …");
    expect(r.stdout).not.toContain("return 1");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(new URL("./__snapshots__/fold-tree-depth-0.expected.txt", import.meta.url)),
    );
  });

  it("renders one child level inside folded call headers at depth one", async () => {
    const r = runOverview(["overview", "fold-tree.ts", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-5: describe("x", () => {');
    expect(r.stdout).toContain("2-4: helper");
    expect(r.stdout).toContain("2 const helper = () => …");
    expect(r.stdout).not.toContain("return 1");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(new URL("./__snapshots__/fold-tree-depth-1.expected.txt", import.meta.url)),
    );
  });

  it("renders barrel re-export edges without loading target files", () => {
    const r = runOverview(["overview", "barrel.ts"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1: export * from "./top-level-functions";');
    expect(r.stdout).toContain('2: export { MyClass } from "./class-with-methods";');
    expect(r.stdout).toContain('3: export * as constants from "./top-level-constants";');
    expect(r.stdout).not.toContain("greet");
    expect(r.stdout).not.toContain("Example");
    expect(r.stdout).not.toContain("(no symbols)");
  });

  it("renders only top-level folds and declarations at depth zero", async () => {
    const r = runOverview(["overview", "default-fold-overview.ts", "--depth", "0"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("8: tap(topLevelValue);");
    expect(r.stdout).toContain("10-13: if (flag) {");
    expect(r.stdout).toContain("15-18: for (const value of values) {");
    expect(r.stdout).toContain("20-23: for (let index = 0; index < values.length; index += 1) {");
    expect(r.stdout).toContain("25-29: while (flag) {");
    expect(r.stdout).toContain("31-42: switch (mode) {");
    expect(r.stdout).toContain("44-47: try {");
    expect(r.stdout).toContain("47-50: catch (error) {");
    expect(r.stdout).toContain("50-53: finally {");
    expect(r.stdout).toContain("55-58: {");
    expect(r.stdout).toContain("60-63: values.map((value) => {");
    expect(r.stdout).toContain("65-76: FoldMemberHost");
    expect(r.stdout).toContain("78-84: outerDeclaration");
    expect(r.stdout).not.toContain("branchValue");
    expect(r.stdout).not.toContain("loopValue");
    expect(r.stdout).not.toContain("callbackValue");
    expect(r.stdout).not.toContain("FoldMemberHost::run");
    expect(r.stdout).not.toContain("outerDeclaration::nestedDeclaration");
    expect(r.stdout).not.toContain("initializerHost::initializerNestedDeclaration");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(new URL("./__snapshots__/default-fold-overview.expected.txt", import.meta.url)),
    );
  });

  it("defaults to explicit depth zero", () => {
    expect(runOverview(["overview", "default-fold-overview.ts"]).stdout).toBe(
      runOverview(["overview", "default-fold-overview.ts", "--depth", "0"]).stdout,
    );
  });

  it("opens one child level inside folds and declarations at depth one", async () => {
    const r = runOverview(["overview", "default-fold-overview.ts", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("branchValue");
    expect(r.stdout).toContain("loopValue");
    expect(r.stdout).toContain("indexedValue");
    expect(r.stdout).toContain("whileValue");
    expect(r.stdout).toContain('case "read":');
    expect(r.stdout).toContain('case "write":');
    expect(r.stdout).toContain("tryValue");
    expect(r.stdout).toContain("caughtError");
    expect(r.stdout).toContain("cleanupValue");
    expect(r.stdout).toContain("blockValue");
    expect(r.stdout).toContain("callbackValue");
    expect(r.stdout).toContain("FoldMemberHost::run");
    expect(r.stdout).toContain("outerDeclaration::nestedDeclaration");
    expect(r.stdout).toContain("initializerHost::initializerNestedDeclaration");
    expect(r.stdout).not.toContain("FoldMemberHost::run::memberBranchValue");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(
        new URL("./__snapshots__/default-fold-overview-depth-1.expected.txt", import.meta.url),
      ),
    );
  });

  it("opens a fold header inside a class member at depth two", async () => {
    const r = runOverview(["overview", "default-fold-overview.ts", "--depth", "2"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("67-70: if (flag) {");
    expect(r.stdout).not.toContain("FoldMemberHost::run::memberBranchValue");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(
        new URL("./__snapshots__/default-fold-overview-depth-2.expected.txt", import.meta.url),
      ),
    );
  });

  it("opens a fold interior inside a class member at depth three", async () => {
    const r = runOverview(["overview", "default-fold-overview.ts", "--depth", "3"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("67-70: if (flag) {");
    expect(r.stdout).toContain("FoldMemberHost::run::memberBranchValue");
    await expect(r.stdout).toMatchFileSnapshot(
      fileURLToPath(
        new URL("./__snapshots__/default-fold-overview-depth-3.expected.txt", import.meta.url),
      ),
    );
  });
});
