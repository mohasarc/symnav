import { describe, expect, it } from "vitest";

import { ErrorOutput } from "../errors/error-output.js";
import { FixtureRunner } from "../fixture-runner.js";
import { symbolCommands } from "../symbol-command.js";

const fixture = new FixtureRunner("javascript-flow-cases");

describe("Flow-typed JavaScript files", () => {
  it("refuses overview", async () => {
    await ErrorOutput.expectSnapshot(fixture.run(["overview", "src/flow.js"]), "flow-typed-file");
  });

  it.each(symbolCommands)("refuses %s on a target in the file", async (command) => {
    await ErrorOutput.expectSnapshot(
      fixture.run([command, "src/flow.js::typed"]),
      "flow-typed-file",
    );
  });

  it("leaves the file's symbols out of resolve", () => {
    const result = fixture.run(["resolve", "--regex", "."]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("src/plain.js\n    └── 3-5: plain");
    expect(result.stdout).not.toContain("typed");
  });
});
