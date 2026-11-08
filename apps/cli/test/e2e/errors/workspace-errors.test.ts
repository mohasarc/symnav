import { afterEach, describe, it } from "vitest";
import { FixtureRunner } from "../fixture-runner.js";
import { symbolCommands } from "../symbol-command.js";
import { ErrorOutput } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

const overviewFixture = new FixtureRunner("overview-cases");
const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

describe("workspace error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it.each([
    ["overview", "src/parent.ts"],
    ["resolve", "parentTarget"],
    ...symbolCommands.map((command) => [command, "parentTarget"] as const),
  ])("%s outside any Git workspace", async (...args) => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");

    await ErrorOutput.expectSnapshot(
      scratch.run(args, { cwd: scratch.root }),
      "not-in-git-workspace",
      {
        placeholders: scratch.placeholders(),
      },
    );
  });

  it("overview of a path outside the workspace", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.writeFile("../outside.ts", "export const outside = 1;\n");

    await ErrorOutput.expectSnapshot(
      scratch.run(["overview", "../outside.ts"]),
      "outside-workspace",
      { placeholders: scratch.placeholders() },
    );
  });

  it("overview of a path inside a nested Git workspace", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.markNestedWorkspace("nested");

    await ErrorOutput.expectSnapshot(
      scratch.run(["overview", "nested/src/nested.ts"]),
      "nested-workspace",
      { placeholders: scratch.placeholders() },
    );
  });

  it("overview of an ignored file", async () => {
    await ErrorOutput.expectSnapshot(
      overviewFixture.run(["overview", "ignored.ts"]),
      "ignored-file",
    );
  });

  it("overview of a missing file", async () => {
    await ErrorOutput.expectSnapshot(
      overviewFixture.run(["overview", "missing.ts"]),
      "file-not-found",
    );
  });

  it("overview of a directory", async () => {
    await ErrorOutput.expectSnapshot(
      overviewFixture.run(["overview", "src/rules"]),
      "directory-input",
    );
  });

  it.skipIf(isWindows || isRoot)("resolve over an unreadable directory", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.makeUnreadableDirectory("src/locked");

    await ErrorOutput.expectSnapshot(
      scratch.run(["resolve", "parentTarget"]),
      "unreadable-directory",
      { placeholders: scratch.placeholders() },
    );
  });

  it.skipIf(isWindows)("resolve over a file path containing ::", async () => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.writeFile("src/a::b.ts", "export function colon(): void {}\n");

    await ErrorOutput.expectSnapshot(
      scratch.run(["resolve", "colon"]),
      "file-path-contains-separator",
    );
  });
});
