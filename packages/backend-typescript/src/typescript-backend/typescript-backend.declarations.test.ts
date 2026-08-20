import { describe, expect, it } from "vitest";
import { InMemoryFileSystem, type ResolvedPath } from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";

const FILES: readonly ResolvedPath[] = [
  { relative: "src/declarations.ts", absolute: "/repo/src/declarations.ts" },
];

describe("TypeScriptBackend.declarations", () => {
  it("enumerates declarations behind folds without target or line filters", async () => {
    const backend = new TypeScriptBackend(
      new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/declarations.ts": [
          "export function outer(flag: boolean): void {",
          "  if (flag) {",
          "    function insideIf(): void {}",
          "    insideIf();",
          "  }",
          "}",
          "",
        ].join("\n"),
      }),
    );

    const declarations = await backend.declarations(FILES);

    expect(declarations.map((symbol) => symbol.identity)).toEqual([
      { file: "src/declarations.ts", segments: [{ name: "outer" }] },
      {
        file: "src/declarations.ts",
        segments: [{ name: "outer" }, { name: "insideIf" }],
      },
    ]);
    expect(declarations[1]!.header.lines.join("\n")).toContain("function insideIf(): void");
  });

  it("returns declarations only from supplied files", async () => {
    const backend = new TypeScriptBackend(
      new InMemoryFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/declarations.ts": "export function included(): void {}\n",
        "/repo/src/other.ts": "export function excluded(): void {}\n",
      }),
    );

    const declarations = await backend.declarations(FILES);

    expect(declarations.map((symbol) => symbol.identity)).toEqual([
      { file: "src/declarations.ts", segments: [{ name: "included" }] },
    ]);
    expect(declarations.some((symbol) => symbol.identity.file === "src/other.ts")).toBe(false);
  });
});
