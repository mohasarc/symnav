import { afterEach, describe, it } from "vitest";
import { ErrorOutput } from "./error-output.js";
import { ScratchWorkspace } from "./scratch-workspace.js";

const duplicateImplementations = [
  "export function merge(value: number): number;",
  "export function merge(value: string): string;",
  "export function merge(value: unknown): unknown {",
  "  return value;",
  "}",
  "export function merge(value: boolean): boolean {",
  "  return value;",
  "}",
  "",
].join("\n");

describe("call target error paths", () => {
  afterEach(() => ScratchWorkspace.disposeAll());

  it.each(["context", "graph"])("%s on duplicate implementations", async (command) => {
    const scratch = new ScratchWorkspace("nested-workspace-cases");
    scratch.writeFile("src/duplicates.ts", duplicateImplementations);

    await ErrorOutput.expectSnapshot(
      scratch.run([command, "merge"]),
      "call-target-multiple-implementations",
    );
  });
});
