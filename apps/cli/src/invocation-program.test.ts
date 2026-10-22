import { describe, expect, it } from "vitest";
import { InvocationProgram } from "./invocation-program.js";

class WarningProgramHarness {
  public static create() {
    const program = new InvocationProgram().option("--no-warnings", "suppress warnings");
    const overview = program.command("overview <file>").option("--at <text>");
    const daemon = program.command("daemon");
    daemon.command("status");
    program.command("setup <agent>");
    program.command("doctor <agent>");
    return { program, overview };
  }
}

describe("InvocationProgram warnings", () => {
  it.each([
    ["--no-warnings", "overview", "input.ts"],
    ["overview", "--no-warnings", "input.ts"],
    ["overview", "input.ts", "--no-warnings"],
    ["--no-warnings", "overview", "input.ts", "--no-warnings"],
    ["--no-warnings", "daemon", "status"],
    ["daemon", "--no-warnings", "status"],
    ["daemon", "status", "--no-warnings"],
    ["setup", "--no-warnings", "codex"],
    ["doctor", "claude-code", "--no-warnings"],
  ])("accepts and selects warning suppression in %j", async (...argv) => {
    const { program } = WarningProgramHarness.create();
    expect(program.warningOptions(argv)).toEqual({ warnings: false });
    await program.parseAsync(argv, { from: "user" });
    expect(program.opts().warnings).toBe(false);
  });

  it.each([
    ["overview", "input.ts", "--at", "--no-warnings"],
    ["overview", "input.ts", "--at=--no-warnings"],
  ])("preserves a literal flag option value in %j", async (...argv) => {
    const { program, overview } = WarningProgramHarness.create();
    expect(program.warningOptions(argv)).toEqual({ warnings: true });
    await program.parseAsync(argv, { from: "user" });
    expect(program.opts().warnings).toBe(true);
    expect(overview.opts().at).toBe("--no-warnings");
  });

  it("preserves the argument separator", async () => {
    const { program, overview } = WarningProgramHarness.create();
    const argv = ["overview", "--", "--no-warnings"];
    expect(program.warningOptions(argv)).toEqual({ warnings: true });
    await program.parseAsync(argv, { from: "user" });
    expect(overview.args).toEqual(["--no-warnings"]);
    expect(program.opts().warnings).toBe(true);
  });
});
