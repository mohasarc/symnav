import { describe, expect, it } from "vitest";
import { parseTs } from "./parse-ts.js";

describe("parseTs", () => {
  it("returns a ts-morph SourceFile with the given content", () => {
    const source = "export const x: number = 1;\n";
    const sf = parseTs(source);
    expect(sf.getFullText()).toBe(source);
  });

  it("uses the provided filename", () => {
    const sf = parseTs("export const x = 1;", "decls.d.ts");
    expect(sf.getBaseName()).toBe("decls.d.ts");
  });
});
