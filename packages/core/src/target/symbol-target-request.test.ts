import { describe, expect, it } from "vitest";

import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import { SymbolTargetRequestMatcher, SymbolTargetRequestParser } from "./symbol-target-request.js";

const helperIdentity: SymbolIdentity = {
  file: "src/unique/helper.ts",
  segments: [{ name: "helper" }],
};

describe("SymbolTargetRequestParser", () => {
  it("keeps regular targets as structured suffix patterns", () => {
    const request = SymbolTargetRequestParser.parse("helper.ts::helper", false);

    expect(request).toEqual({
      mode: "regular",
      raw: "helper.ts::helper",
      pattern: {
        raw: "helper.ts::helper",
        fileSuffix: "helper.ts",
        segmentSuffix: [{ name: "helper" }],
      },
    });
  });

  it("keeps regex text and its compiled expression", () => {
    const request = SymbolTargetRequestParser.parse("helper\\.ts::helper$", true);

    expect(request.mode).toBe("regex");
    if (request.mode !== "regex") return;
    expect(request.raw).toBe("helper\\.ts::helper$");
    expect(request.expression.source).toBe("helper\\.ts::helper$");
  });
});

describe("SymbolTargetRequestMatcher", () => {
  it("tests regex requests against the full canonical symbol id", () => {
    const request = SymbolTargetRequestParser.parse("^src/unique/helper\\.ts::helper$", true);

    expect(SymbolTargetRequestMatcher.matches(request, helperIdentity)).toBe(true);
  });

  it("keeps regex matching case-sensitive", () => {
    const request = SymbolTargetRequestParser.parse("HELPER$", true);

    expect(SymbolTargetRequestMatcher.matches(request, helperIdentity)).toBe(false);
  });

  it("includes canonical overload disambiguators", () => {
    const overloadedIdentity: SymbolIdentity = {
      file: "src/routing/router.ts",
      segments: [{ name: "Router" }, { name: "post", disambiguator: 2 }],
    };
    const request = SymbolTargetRequestParser.parse("Router::post#2$", true);

    expect(SymbolTargetRequestMatcher.matches(request, overloadedIdentity)).toBe(true);
  });

  it("does not match declaration source text", () => {
    const request = SymbolTargetRequestParser.parse("unique-helper", true);

    expect(SymbolTargetRequestMatcher.matches(request, helperIdentity)).toBe(false);
  });
});
