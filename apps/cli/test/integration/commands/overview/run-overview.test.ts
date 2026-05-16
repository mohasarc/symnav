import { describe, expect, it } from "vitest";
import {
  BackendRouter,
  createWorkspace,
  FileNotFoundError,
  InMemoryFileSystem,
  OutsideWorkspaceError,
  UnsupportedFileError,
  UserFacingError,
} from "@symnav/core";
import type { FileSymbols } from "@symnav/core";
import { runOverview } from "../../../../src/commands/overview/run-overview.js";
import { FakeLanguageBackend } from "./fake-language-backend.js";

describe("runOverview happy path", () => {
  it("returns the backend's FileSymbols for a relative input under cwd=root", async () => {
    const expected: FileSymbols = { filePath: "src/a.ts", symbols: [] };
    const backend = new FakeLanguageBackend({
      symbols: () => expected,
    });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
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
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
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
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/nested/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
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
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
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

describe("runOverview validation errors", () => {
  it("throws FileNotFoundError when the resolved path does not exist", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "src/missing.ts",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("throws OutsideWorkspaceError for a path outside the workspace root", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;",
      "/other/src/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "/other/src/a.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("rejects an ignored path with a UserFacingError", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
      "/repo/build/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    const error = await runOverview({
      workspace,
      router,
      cwd: "/repo",
      inputPath: "build/a.ts",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).reason).toBe("build/a.ts is ignored by .gitignore");
  });

  it("throws UnsupportedFileError when no backend accepts the path", async () => {
    const backend = new FakeLanguageBackend({ accept: () => false });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/README.md": "# repo",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "README.md",
      }),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});

describe("runOverview validation order", () => {
  it("prefers FileNotFoundError over OutsideWorkspaceError", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "/other/missing.ts",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("prefers FileNotFoundError over IgnoredFileError", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "build/missing.ts",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("prefers FileNotFoundError over UnsupportedFileError", async () => {
    const backend = new FakeLanguageBackend({ accept: () => false });
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "missing.md",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("prefers OutsideWorkspaceError over IgnoredFileError", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
      "/other/build/a.ts": "export const x = 1;",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "/other/build/a.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("prefers OutsideWorkspaceError over UnsupportedFileError", async () => {
    const backend = new FakeLanguageBackend({ accept: () => false });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/README.md": "# other",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      runOverview({
        workspace,
        router,
        cwd: "/repo",
        inputPath: "/other/README.md",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("prefers the ignored-file rejection over UnsupportedFileError", async () => {
    const backend = new FakeLanguageBackend({ accept: () => false });
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
      "/repo/build/notes.md": "notes",
    });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    const error = await runOverview({
      workspace,
      router,
      cwd: "/repo",
      inputPath: "build/notes.md",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).not.toBeInstanceOf(UnsupportedFileError);
    expect((error as UserFacingError).reason).toBe("build/notes.md is ignored by .gitignore");
  });
});
