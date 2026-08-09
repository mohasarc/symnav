import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "@symnav/core";

import { runCommand } from "../../../src/command.js";
import { defCommand } from "../../../src/commands/def/def-command.js";
import { FakeLanguageBackend } from "./helpers/fake-language-backend.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";
import { fakeDependencies } from "./helpers/fake-program-dependencies.js";

describe("symbol target command errors", () => {
  it("reports a workspace whose files no backend supports", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({
          "/repo/.git/HEAD": "ref: refs/heads/main\n",
          "/repo/README.md": "docs only\n",
        }),
        backends: () => [new FakeLanguageBackend({ accept: () => false })],
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "helper", line: undefined, regex: false },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: workspace contains no files supported by any language backend.\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("rejects a malformed --line value echoing the raw input", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "walk", line: "abc", regex: false },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe(
      "Cannot answer: line must be a positive integer, got abc.\n",
    );
    expect(context.exitCodes).toEqual([1]);
  });

  it("rejects a non-positive --line value echoing the raw input", async () => {
    const context = createFakeProgramContext({ cwd: "/repo" });

    await runCommand(defCommand, {
      context,
      dependencies: fakeDependencies({
        fs: new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" }),
      }),
      cwdOverride: undefined,
      json: false,
      args: { target: "walk", line: "0", regex: false },
    });

    expect(context.stdout.text()).toBe("");
    expect(context.stderr.text()).toBe("Cannot answer: line must be a positive integer, got 0.\n");
    expect(context.exitCodes).toEqual([1]);
  });
});
