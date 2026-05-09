import { describe, expect, it } from "vitest";

import * as coreEntry from "./index.js";

describe("@symnav/core entry", () => {
  it("exposes the expected runtime exports", () => {
    expect(Object.keys(coreEntry).sort()).toMatchInlineSnapshot(`
      [
        "AbstractWorkspace",
        "NodeFileSystem",
        "NodeWorkspace",
        "NotInWorkspaceError",
        "buildSymbolPath",
      ]
    `);
  });
});
