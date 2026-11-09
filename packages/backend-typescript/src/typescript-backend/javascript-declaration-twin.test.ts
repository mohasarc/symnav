import { describe, expect, it } from "vitest";

import { JavaScriptDeclarationTwin } from "./javascript-declaration-twin.js";

describe("JavaScriptDeclarationTwin.fileOf", () => {
  it.each([
    ["src/Tabs/Tabs.js", "src/Tabs/Tabs.d.ts"],
    ["src/App.jsx", "src/App.d.ts"],
    ["src/lib.mjs", "src/lib.d.mts"],
    ["src/legacy.cjs", "src/legacy.d.cts"],
  ])("maps %s to its declaration twin %s", (javaScriptFile, declarationFile) => {
    expect(JavaScriptDeclarationTwin.fileOf(javaScriptFile)).toBe(declarationFile);
  });

  it.each(["src/use.ts", "src/Tabs/Tabs.d.ts", "src/view.tsx", "README.md"])(
    "has no declaration twin for %s",
    (file) => {
      expect(JavaScriptDeclarationTwin.fileOf(file)).toBeUndefined();
    },
  );
});
