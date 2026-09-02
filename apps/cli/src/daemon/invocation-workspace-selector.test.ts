import { describe, expect, it } from "vitest";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

describe("InvocationWorkspaceSelector", () => {
  const selector = new InvocationWorkspaceSelector();

  it("routes navigation commands through the selected workspace", () => {
    expect(selector.classify(["overview", "src/a.ts"], "/repo")).toEqual({
      kind: "workspace",
      startDir: "/repo",
    });
    expect(selector.classify(["--cwd", "/other", "refs", "target"], "/repo")).toEqual({
      kind: "workspace",
      startDir: "/other",
    });
    expect(selector.classify(["--cwd", "..", "refs", "target"], "/repo/nested")).toEqual({
      kind: "workspace",
      startDir: "/repo",
    });
    expect(selector.select(["--cwd", "..", "refs", "target"], "/repo/nested")).toEqual({
      route: { kind: "workspace", startDir: "/repo" },
      argv: ["--cwd", "/repo", "refs", "target"],
    });
    expect(selector.classify(["stats", "--json"], "/repo")).toEqual({
      kind: "workspace",
      startDir: "/repo",
    });
  });

  it("rewrites only the effective cwd option before the separator", () => {
    expect(
      selector.select(
        ["--cwd=first", "--cwd", "second", "resolve", "--", "--cwd=target"],
        "/repo/client",
      ),
    ).toEqual({
      route: { kind: "workspace", startDir: "/repo/client/second" },
      argv: ["--cwd=first", "--cwd", "/repo/client/second", "resolve", "--", "--cwd=target"],
    });
  });

  it.each(["--help", "--version"])(
    "keeps %s positional after the separator on the workspace route",
    (target) => {
      expect(selector.select(["resolve", "--", target], "/repo")).toEqual({
        route: { kind: "workspace", startDir: "/repo" },
        argv: ["resolve", "--", target],
      });
    },
  );

  it.each(["start", "status", "stop"] as const)(
    "classifies daemon %s as a control invocation",
    (action) => {
      expect(selector.classify(["daemon", action], "/repo")).toEqual({
        kind: "daemon-control",
        action,
      });
    },
  );

  it.each([[[]], [["--help"]], [["--version"]], [["overview", "--help"]], [["unknown"]]])(
    "keeps non-workspace invocation %j local",
    (argv) => {
      expect(selector.classify(argv, "/repo")).toEqual({ kind: "local" });
    },
  );
});
