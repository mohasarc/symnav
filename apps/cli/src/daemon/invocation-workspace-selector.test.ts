import { describe, expect, it } from "vitest";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";

describe("InvocationWorkspaceSelector", () => {
  const selector = new InvocationWorkspaceSelector();

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
