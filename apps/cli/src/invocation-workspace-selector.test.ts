import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonCommandName } from "@symnav/daemon";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

describe("InvocationWorkspaceSelector", () => {
  const selector = new InvocationWorkspaceSelector();
  const workspaceRoot = resolve("synthetic-workspace");
  const nestedWorkspaceDirectory = join(workspaceRoot, "nested");
  const clientWorkspaceDirectory = join(workspaceRoot, "client");
  const otherWorkspaceRoot = resolve("other-synthetic-workspace");

  it.each([
    "overview",
    "resolve",
    "def",
    "refs",
    "context",
    "graph",
    "stats",
  ] satisfies readonly DaemonCommandName[])(
    "maps workspace command %s to its daemon name",
    (commandName) => {
      expect(selector.select([commandName, "target"], workspaceRoot)).toEqual({
        route: { kind: "workspace", commandName, startDirectory: workspaceRoot },
        argv: [commandName, "target"],
      });
    },
  );

  it("absolutizes cwd overrides through the selected workspace", () => {
    expect(selector.select(["--cwd", otherWorkspaceRoot, "refs", "target"], workspaceRoot)).toEqual(
      {
        route: { kind: "workspace", commandName: "refs", startDirectory: otherWorkspaceRoot },
        argv: ["--cwd", otherWorkspaceRoot, "refs", "target"],
      },
    );
    expect(selector.select(["--cwd", "..", "refs", "target"], nestedWorkspaceDirectory)).toEqual({
      route: { kind: "workspace", commandName: "refs", startDirectory: workspaceRoot },
      argv: ["--cwd", workspaceRoot, "refs", "target"],
    });
  });

  it("rewrites only the effective cwd option before the separator", () => {
    const effectiveWorkspaceDirectory = join(clientWorkspaceDirectory, "second");
    expect(
      selector.select(
        ["--cwd=first", "--cwd", "second", "resolve", "--", "--cwd=target"],
        clientWorkspaceDirectory,
      ),
    ).toEqual({
      route: {
        kind: "workspace",
        commandName: "resolve",
        startDirectory: effectiveWorkspaceDirectory,
      },
      argv: ["--cwd=first", "--cwd", effectiveWorkspaceDirectory, "resolve", "--", "--cwd=target"],
    });
  });

  it.each(["--help", "--version"])(
    "keeps %s positional after the separator on the workspace route",
    (target) => {
      expect(selector.select(["resolve", "--", target], workspaceRoot)).toEqual({
        route: { kind: "workspace", commandName: "resolve", startDirectory: workspaceRoot },
        argv: ["resolve", "--", target],
      });
    },
  );

  it.each(["start", "status", "stop"] as const)(
    "classifies daemon %s as a control invocation",
    (action) => {
      expect(selector.select(["daemon", action], workspaceRoot)).toEqual({
        route: { kind: "control", action },
        argv: ["daemon", action],
      });
    },
  );

  it.each([
    { argv: ["--help"], commandName: "help" },
    { argv: ["-h"], commandName: "help" },
    { argv: ["overview", "--help"], commandName: "help" },
    { argv: ["--version"], commandName: "version" },
    { argv: ["-v"], commandName: "version" },
    { argv: [], commandName: "unknown" },
    { argv: ["unknown"], commandName: "unknown" },
    { argv: ["daemon", "unknown"], commandName: "unknown" },
  ] satisfies readonly {
    readonly argv: readonly string[];
    readonly commandName: DaemonCommandName;
  }[])("maps local invocation $argv to $commandName", ({ argv, commandName }) => {
    expect(selector.select(argv, workspaceRoot)).toEqual({
      route: { kind: "local", commandName },
      argv,
    });
  });
});
