import { describe, expect, it } from "vitest";
import { BackendRouter } from "@symnav/core";
import type { FileSymbols } from "@symnav/core";
import { runOverview } from "../../../../src/commands/overview/run-overview.js";
import { InMemoryWorkspace } from "../../../helpers/in-memory-workspace.js";
import { FakeLanguageBackend } from "./fake-language-backend.js";

describe("runOverview happy path", () => {
  it("returns the backend's FileSymbols for a relative input under cwd=root", async () => {
    const expected: FileSymbols = { filePath: "src/a.ts", symbols: [] };
    const backend = new FakeLanguageBackend({
      symbols: () => expected,
    });
    const workspace = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;",
      },
      startDir: "/repo",
    });
    const router = new BackendRouter([backend]);

    const result = await runOverview({
      workspace,
      router,
      cwd: "/repo",
      inputPath: "src/a.ts",
    });

    expect(result).toBe(expected);
  });

  it("returns the same IR for an absolute input path", async () => {
    const expected: FileSymbols = { filePath: "src/a.ts", symbols: [] };
    const backend = new FakeLanguageBackend({ symbols: () => expected });
    const workspace = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;",
      },
      startDir: "/repo",
    });
    const router = new BackendRouter([backend]);

    const result = await runOverview({
      workspace,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/a.ts",
    });

    expect(result).toBe(expected);
  });

  it("resolves a relative input against cwd, not the workspace root", async () => {
    const backend = new FakeLanguageBackend();
    const workspace = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/nested/a.ts": "export const x = 1;",
      },
      startDir: "/repo",
    });
    const router = new BackendRouter([backend]);

    await runOverview({
      workspace,
      router,
      cwd: "/repo/src/nested",
      inputPath: "a.ts",
    });

    expect(backend.calls).toEqual(["src/nested/a.ts"]);
  });

  it("invokes the backend with the workspace-relative POSIX path", async () => {
    const backend = new FakeLanguageBackend();
    const workspace = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const x = 1;",
      },
      startDir: "/repo",
    });
    const router = new BackendRouter([backend]);

    await runOverview({
      workspace,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/a.ts",
    });

    expect(backend.calls).toEqual(["src/a.ts"]);
  });
});
