import { describe, expect, it } from "vitest";
import { parseTs } from "./parse-ts.js";

describe("parseTs", () => {
  it("returns a ts-morph SourceFile whose text round-trips the input", () => {
    const source = "export const answer = 42;\n";
    const sourceFile = parseTs(source);
    expect(sourceFile.getFullText()).toBe(source);
  });

  it("uses test.ts as the default file name", () => {
    const sourceFile = parseTs("export {};\n");
    expect(sourceFile.getBaseName()).toBe("test.ts");
  });

  it("honors a custom file name", () => {
    const sourceFile = parseTs("export {};\n", "test.tsx");
    expect(sourceFile.getBaseName()).toBe("test.tsx");
  });

  it("parses .d.ts declaration files", () => {
    const sourceFile = parseTs("export declare const x: number;\n", "decls.d.ts");
    expect(sourceFile.getBaseName()).toBe("decls.d.ts");
  });
});
