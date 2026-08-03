import { describe, expect, it } from "vitest";

import { runOverview } from "./run-overview.js";

describe("symnav overview e2e (fold tree)", () => {
  it("renders folded call headers and nested declarations without callback body lines", () => {
    const r = runOverview(["overview", "fold-tree.ts", "--depth", "1"]);

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1-5: describe("x", () => {');
    expect(r.stdout).toContain("2-4: helper");
    expect(r.stdout).toContain("2 const helper = () => …");
    expect(r.stdout).not.toContain("return 1");
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

  it("renders default fold headers without opening fold interiors", async () => {
    const r = runOverview(["overview", "default-fold-overview.ts"]);

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
    expect(r.stdout).toContain("67-70: if (flag) {");
    expect(r.stdout).toContain("initializerHost::initializerNestedDeclaration");
    expect(r.stdout).not.toContain("branchValue");
    expect(r.stdout).not.toContain("loopValue");
    expect(r.stdout).not.toContain("callbackValue");
    await expect(r.stdout).toMatchFileSnapshot(
      new URL("./__snapshots__/default-fold-overview.expected.txt", import.meta.url).pathname,
    );
  });

  it("opens one fold interior with nested declarations at depth one", async () => {
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
    expect(r.stdout).toContain("FoldMemberHost::run::memberBranchValue");
    await expect(r.stdout).toMatchFileSnapshot(
      new URL("./__snapshots__/default-fold-overview-depth-1.expected.txt", import.meta.url)
        .pathname,
    );
  });
});
