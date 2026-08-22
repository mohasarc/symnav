import { describe, expect, it } from "vitest";

import { TypeScriptBackend } from "@symnav/backend-typescript";
import { InMemoryFileSystem, type ResultWithDiagnostics } from "@symnav/core";

import { runCommand, type Command } from "../../../src/command.js";
import { defCommand, type DefArgs } from "../../../src/commands/def/def-command.js";
import { graphCommand, type GraphArgs } from "../../../src/commands/graph/graph-command.js";
import { resolveCommand } from "../../../src/commands/resolve/resolve-command.js";
import { createFakeProgramContext } from "./helpers/fake-program-context.js";
import { fakeDependencies } from "./helpers/fake-program-dependencies.js";

class FailingBackendPreparationFileSystem extends InMemoryFileSystem {
  readonly sourceReads: string[] = [];

  constructor() {
    super({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/unreadable.ts": "export const unreadable = true;\n",
    });
  }

  override readFileSync(absPath: string): string {
    if (absPath.endsWith(".ts")) {
      this.sourceReads.push(absPath);
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return super.readFileSync(absPath);
  }
}

class FailingWorkspaceDiscoveryFileSystem extends InMemoryFileSystem {
  override existsSync(absPath: string): boolean {
    if (absPath.endsWith("/.git")) {
      throw new Error("workspace discovery failed");
    }
    return super.existsSync(absPath);
  }
}

async function runRequest<Result extends ResultWithDiagnostics, Args>(
  command: Command<Result, Args>,
  args: Args,
  fs: InMemoryFileSystem,
  cwd: string,
): Promise<{
  readonly stderr: string;
  readonly exitCodes: readonly number[];
}> {
  const context = createFakeProgramContext({ cwd });

  await runCommand(command, {
    context,
    dependencies: fakeDependencies({
      fs,
      backends: () => [new TypeScriptBackend(fs)],
    }),
    cwdOverride: undefined,
    json: false,
    args,
  });

  expect(context.stdout.text()).toBe("");
  return { stderr: context.stderr.text(), exitCodes: context.exitCodes };
}

async function runInvalidRequest<Result extends ResultWithDiagnostics, Args>(
  command: Command<Result, Args>,
  args: Args,
): Promise<{
  readonly stderr: string;
  readonly exitCodes: readonly number[];
  readonly reads: readonly string[];
}> {
  const context = createFakeProgramContext({ cwd: "/repo" });
  const fs = new FailingBackendPreparationFileSystem();
  const result = await runRequest(command, args, fs, context.cwd);
  return { ...result, reads: fs.sourceReads };
}

const graphArgs = (overrides: Partial<GraphArgs>): GraphArgs => ({
  target: "entry",
  line: undefined,
  regex: false,
  incoming: false,
  outgoing: false,
  depth: undefined,
  page: undefined,
  pageSize: undefined,
  all: false,
  ...overrides,
});

describe("request validation before backend preparation", () => {
  it("rejects conflicting resolve modes before reading workspace sources", async () => {
    const result = await runInvalidRequest(resolveCommand, {
      query: "entry",
      fuzzy: true,
      regex: true,
    });

    expect(result.stderr).toBe("Cannot answer: --regex cannot be combined with --fuzzy.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });

  it("rejects an invalid resolve regex before reading workspace sources", async () => {
    const result = await runInvalidRequest(resolveCommand, {
      query: "[",
      fuzzy: false,
      regex: true,
    });

    expect(result.stderr).toContain('Cannot answer: invalid regex "[":');
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });

  it("rejects conflicting graph directions before reading workspace sources", async () => {
    const result = await runInvalidRequest(
      graphCommand,
      graphArgs({ incoming: true, outgoing: true }),
    );

    expect(result.stderr).toBe("Cannot answer: --incoming cannot be combined with --outgoing.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });

  it("rejects invalid graph depth before reading workspace sources", async () => {
    const result = await runInvalidRequest(graphCommand, graphArgs({ depth: "0" }));

    expect(result.stderr).toBe("Cannot answer: depth must be a positive integer, got 0.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });

  it("rejects an invalid symbol target before reading workspace sources", async () => {
    const args: DefArgs = { target: "::charge", line: undefined, regex: false };
    const result = await runInvalidRequest(defCommand, args);

    expect(result.stderr).toBe(
      'Cannot answer: invalid symbol target (empty path segment between "::" separators): "::charge".\n',
    );
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });

  it("rejects an invalid symbol line before reading workspace sources", async () => {
    const args: DefArgs = { target: "charge", line: "abc", regex: false };
    const result = await runInvalidRequest(defCommand, args);

    expect(result.stderr).toBe("Cannot answer: line must be a positive integer, got abc.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(result.reads).toEqual([]);
  });
});

describe("workspace discovery before request validation", () => {
  it("reports a missing workspace before conflicting resolve modes", async () => {
    const result = await runRequest(
      resolveCommand,
      { query: "entry", fuzzy: true, regex: true },
      new InMemoryFileSystem({ "/loose/entry.ts": "export const entry = true;\n" }),
      "/loose",
    );

    expect(result.stderr).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(result.exitCodes).toEqual([1]);
  });

  it("reports a missing workspace before conflicting graph directions", async () => {
    const result = await runRequest(
      graphCommand,
      graphArgs({ incoming: true, outgoing: true }),
      new InMemoryFileSystem({ "/loose/entry.ts": "export const entry = true;\n" }),
      "/loose",
    );

    expect(result.stderr).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(result.exitCodes).toEqual([1]);
  });

  it("reports a missing workspace before an invalid shared symbol target", async () => {
    const args: DefArgs = { target: "::charge", line: undefined, regex: false };
    const result = await runRequest(
      defCommand,
      args,
      new InMemoryFileSystem({ "/loose/entry.ts": "export const entry = true;\n" }),
      "/loose",
    );

    expect(result.stderr).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(result.exitCodes).toEqual([1]);
  });

  it("surfaces an unexpected workspace discovery failure before request validation", async () => {
    const result = await runRequest(
      resolveCommand,
      { query: "entry", fuzzy: true, regex: true },
      new FailingWorkspaceDiscoveryFileSystem({
        "/repo/entry.ts": "export const entry = true;\n",
      }),
      "/repo",
    );

    expect(result.stderr).toBe("workspace discovery failed\n");
    expect(result.exitCodes).toEqual([2]);
  });
});
