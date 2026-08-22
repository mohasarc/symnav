import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

describe("InvocationWorkspaceSelector", () => {
  const selector = new InvocationWorkspaceSelector();
  const workspaceRoot = resolve("synthetic-workspace");
  const nestedWorkspaceDirectory = join(workspaceRoot, "nested");
  const clientWorkspaceDirectory = join(workspaceRoot, "client");
  const otherWorkspaceRoot = resolve("other-synthetic-workspace");

  it("routes navigation commands through the selected workspace", () => {
    expect(selector.classify(["overview", "src/a.ts"], workspaceRoot)).toEqual({
      kind: "workspace",
      startDir: workspaceRoot,
    });
    expect(
      selector.classify(["--cwd", otherWorkspaceRoot, "refs", "target"], workspaceRoot),
    ).toEqual({
      kind: "workspace",
      startDir: otherWorkspaceRoot,
    });
    expect(selector.classify(["--cwd", "..", "refs", "target"], nestedWorkspaceDirectory)).toEqual({
      kind: "workspace",
      startDir: workspaceRoot,
    });
    expect(selector.select(["--cwd", "..", "refs", "target"], nestedWorkspaceDirectory)).toEqual({
      route: { kind: "workspace", startDir: workspaceRoot },
      argv: ["--cwd", workspaceRoot, "refs", "target"],
    });
    expect(selector.classify(["stats", "--json"], workspaceRoot)).toEqual({
      kind: "workspace",
      startDir: workspaceRoot,
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
      route: { kind: "workspace", startDir: effectiveWorkspaceDirectory },
      argv: ["--cwd=first", "--cwd", effectiveWorkspaceDirectory, "resolve", "--", "--cwd=target"],
    });
  });

  it.each(["--help", "--version"])(
    "keeps %s positional after the separator on the workspace route",
    (target) => {
      expect(selector.select(["resolve", "--", target], workspaceRoot)).toEqual({
        route: { kind: "workspace", startDir: workspaceRoot },
        argv: ["resolve", "--", target],
      });
    },
  );

  it.each(["start", "status", "stop"] as const)(
    "classifies daemon %s as a control invocation",
    (action) => {
      expect(selector.classify(["daemon", action], workspaceRoot)).toEqual({
        kind: "daemon-control",
        action,
      });
    },
  );

  it.each([[[]], [["--help"]], [["--version"]], [["overview", "--help"]], [["unknown"]]])(
    "keeps non-workspace invocation %j local",
    (argv) => {
      expect(selector.classify(argv, workspaceRoot)).toEqual({ kind: "local" });
    },
  );
});
