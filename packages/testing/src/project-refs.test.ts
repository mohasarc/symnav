import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readReferences(tsconfigRelPath: string): string[] {
  const raw = readFileSync(join(repoRoot, tsconfigRelPath), "utf8");
  const parsed = JSON.parse(raw) as { references?: { path: string }[] };
  return (parsed.references ?? []).map((r) => r.path);
}

describe("tsconfig project references", () => {
  it("@symnav/core has no internal references", () => {
    expect(readReferences("packages/core/tsconfig.json")).toEqual([]);
  });

  it("@symnav/renderer references only @symnav/core", () => {
    expect(readReferences("packages/renderer/tsconfig.json")).toEqual(["../core"]);
  });

  it("@symnav/backend-typescript references only @symnav/core", () => {
    expect(readReferences("packages/backend-typescript/tsconfig.json")).toEqual(["../core"]);
  });

  it("@symnav/testing references only @symnav/core", () => {
    expect(readReferences("packages/testing/tsconfig.json")).toEqual(["../core"]);
  });

  it("apps/cli references all three production libs", () => {
    expect(readReferences("apps/cli/tsconfig.json")).toEqual([
      "../../packages/core",
      "../../packages/renderer",
      "../../packages/backend-typescript",
    ]);
  });

  it("no production tsconfig.json references @symnav/testing", () => {
    const productionConfigs = [
      "packages/core/tsconfig.json",
      "packages/renderer/tsconfig.json",
      "packages/backend-typescript/tsconfig.json",
      "apps/cli/tsconfig.json",
    ];
    for (const cfg of productionConfigs) {
      const refs = readReferences(cfg);
      expect(refs.some((r) => r.includes("testing"))).toBe(false);
    }
  });

  it("each package's tsconfig.test.json references its production tsconfig.json and @symnav/testing", () => {
    const testConfigs: { path: string; testingRef: string }[] = [
      { path: "packages/core/tsconfig.test.json", testingRef: "../testing" },
      { path: "packages/renderer/tsconfig.test.json", testingRef: "../testing" },
      { path: "packages/backend-typescript/tsconfig.test.json", testingRef: "../testing" },
      { path: "apps/cli/tsconfig.test.json", testingRef: "../../packages/testing" },
    ];
    for (const { path, testingRef } of testConfigs) {
      expect(readReferences(path)).toEqual(["./tsconfig.json", testingRef]);
    }
  });

  it("@symnav/testing's own tsconfig.test.json references only its production tsconfig.json", () => {
    expect(readReferences("packages/testing/tsconfig.test.json")).toEqual(["./tsconfig.json"]);
  });
});
