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
import { OverviewCommand } from "../../../../src/commands/overview/overview-command.js";
import { FakeLanguageBackend } from "../helpers/fake-language-backend.js";

describe("OverviewCommand.compute happy path", () => {
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

    const result = await new OverviewCommand("src/a.ts").compute({
      workspace,
      router,
      cwd: "/repo",
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

    const result = await new OverviewCommand("/repo/src/a.ts").compute({
      workspace,
      router,
      cwd: "/repo",
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

    await new OverviewCommand("a.ts").compute({
      workspace,
      router,
      cwd: "/repo/src/nested",
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

    await new OverviewCommand("/repo/src/a.ts").compute({
      workspace,
      router,
      cwd: "/repo",
    });

    expect(backend.calls).toEqual(["src/a.ts"]);
  });
});

describe("OverviewCommand.compute validation errors", () => {
  it("throws FileNotFoundError when the resolved path does not exist", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      new OverviewCommand("src/missing.ts").compute({ workspace, router, cwd: "/repo" }),
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
      new OverviewCommand("/other/src/a.ts").compute({ workspace, router, cwd: "/repo" }),
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

    const error = await new OverviewCommand("build/a.ts")
      .compute({ workspace, router, cwd: "/repo" })
      .catch((thrown: unknown) => thrown);

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
      new OverviewCommand("README.md").compute({ workspace, router, cwd: "/repo" }),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});

describe("OverviewCommand.compute validation order", () => {
  it("prefers FileNotFoundError over OutsideWorkspaceError", async () => {
    const backend = new FakeLanguageBackend();
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      new OverviewCommand("/other/missing.ts").compute({ workspace, router, cwd: "/repo" }),
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
      new OverviewCommand("build/missing.ts").compute({ workspace, router, cwd: "/repo" }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("prefers FileNotFoundError over UnsupportedFileError", async () => {
    const backend = new FakeLanguageBackend({ accept: () => false });
    const fs = new InMemoryFileSystem({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const workspace = await createWorkspace({ startDir: "/repo", fs });
    const router = new BackendRouter([backend]);

    await expect(
      new OverviewCommand("missing.md").compute({ workspace, router, cwd: "/repo" }),
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
      new OverviewCommand("/other/build/a.ts").compute({ workspace, router, cwd: "/repo" }),
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
      new OverviewCommand("/other/README.md").compute({ workspace, router, cwd: "/repo" }),
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

    const error = await new OverviewCommand("build/notes.md")
      .compute({ workspace, router, cwd: "/repo" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).not.toBeInstanceOf(UnsupportedFileError);
    expect((error as UserFacingError).reason).toBe("build/notes.md is ignored by .gitignore");
  });
});
