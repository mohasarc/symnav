import { describe, expect, it } from "vitest";

import { parseTypeScriptSource } from "./parse-typescript-source.js";

describe("parseTypeScriptSource", () => {
  it("returns a ts-morph SourceFile whose full text round-trips", () => {
    const source = "export function greet(name: string): string {\n  return name;\n}\n";
    const sourceFile = parseTypeScriptSource(source);
    expect(sourceFile.getFullText()).toBe(source);
  });
});
