import { describe, expectTypeOf, it } from "vitest";

import type { CallSite } from "./call-edge.js";
import type { SymbolReference } from "./references.js";
import type { SourceMatch } from "./source-match.js";

describe("SourceMatch", () => {
  it("is the shared source-location shape for references and call sites", () => {
    expectTypeOf<CallSite>().toEqualTypeOf<SourceMatch>();
    expectTypeOf<SymbolReference>().toMatchTypeOf<SourceMatch>();
  });
});
