import { describe, expect, it } from "vitest";

import { runOverview } from "./run-overview.js";

describe("symnav overview unsupported inputs", () => {
  it("reports directory inputs as unsupported source files", () => {
    const result = runOverview(["overview", "src/rules"]);

    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Cannot answer: src/rules is a directory; expected a source file.\n",
    );
  });
});
