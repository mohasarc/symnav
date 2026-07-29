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

  it("reports extensionless inputs as unsupported source files", () => {
    const result = runSymnavBinary(["overview", "extensionless"], { cwd: fixtureRoot });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Cannot answer: extensionless has no file extension; expected a source file.\n",
    );
  });

  it("reports non-TypeScript inputs as unsupported source files", () => {
    const result = runSymnavBinary(["overview", "unsupported.md"], { cwd: fixtureRoot });

    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Cannot answer: cannot read .md files (unsupported.md).\n");
  });
});
