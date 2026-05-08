import { describe, expect, it } from "vitest";
import {
  BackendRouter,
  FileNotFoundError,
  IgnoredFileError,
  type LanguageBackend,
  OutsideWorkspaceError,
  runOverview,
  UnsupportedFileError,
} from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";

function recordingBackend(extensions: readonly string[]): {
  backend: LanguageBackend;
  calls: string[];
} {
  const calls: string[] = [];
  const backend: LanguageBackend = {
    accepts(filePath) {
      return extensions.some((ext) => filePath.endsWith(ext));
    },
    fileSymbols(filePath) {
      calls.push(filePath);
      return Promise.resolve({ filePath, symbols: [] });
    },
  };
  return { backend, calls };
}

async function makeWorkspace(extra: Record<string, string> = {}) {
  return inMemoryWorkspace({
    files: {
      "/repo/.git/HEAD": "",
      "/repo/.gitignore": "ignored.ts\n",
      "/repo/src/x.ts": "",
      "/repo/src/y.ts": "",
      "/repo/ignored.ts": "",
      "/repo/foo.json": "{}",
      ...extra,
    },
    startDir: "/repo",
  });
}

describe("runOverview happy path", () => {
  it("relative input resolves against cwd, returns backend IR", async () => {
    const ws = await makeWorkspace();
    const { backend, calls } = recordingBackend([".ts"]);
    const router = new BackendRouter([backend]);
    const result = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo/src",
      inputPath: "x.ts",
    });
    expect(result.filePath).toBe("src/x.ts");
    expect(calls).toEqual(["src/x.ts"]);
  });

  it("absolute input path returns the same IR shape", async () => {
    const ws = await makeWorkspace();
    const { backend } = recordingBackend([".ts"]);
    const router = new BackendRouter([backend]);
    const result = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/x.ts",
    });
    expect(result.filePath).toBe("src/x.ts");
  });

  it("relative path resolves against cwd, not workspace root", async () => {
    const ws = await makeWorkspace();
    const { backend, calls } = recordingBackend([".ts"]);
    const router = new BackendRouter([backend]);
    await runOverview({
      workspace: ws,
      router,
      cwd: "/repo/src",
      inputPath: "y.ts",
    });
    expect(calls).toEqual(["src/y.ts"]);
  });

  it("backend receives workspace-relative POSIX path", async () => {
    const ws = await makeWorkspace();
    const { backend, calls } = recordingBackend([".ts"]);
    const router = new BackendRouter([backend]);
    await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/x.ts",
    });
    expect(calls[0]).toBe("src/x.ts");
    expect(calls[0]?.startsWith("/")).toBe(false);
  });
});

describe("runOverview validation errors", () => {
  it("missing file → FileNotFoundError with the user's input path as displayedPath", async () => {
    const ws = await makeWorkspace();
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    try {
      await runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "missing.ts",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FileNotFoundError);
      expect((err as FileNotFoundError).displayedPath).toBe("missing.ts");
    }
  });

  it("path outside workspace → OutsideWorkspaceError", async () => {
    const ws = await makeWorkspace({ "/elsewhere/x.ts": "" });
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/x.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("ignored path → IgnoredFileError", async () => {
    const ws = await makeWorkspace();
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "ignored.ts",
      }),
    ).rejects.toBeInstanceOf(IgnoredFileError);
  });

  it("no backend accepts → UnsupportedFileError carrying the extension", async () => {
    const ws = await makeWorkspace();
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    try {
      await runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "foo.json",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedFileError);
      expect((err as UnsupportedFileError).extension).toBe(".json");
    }
  });
});

describe("runOverview validation order", () => {
  it("missing wins over outside-workspace", async () => {
    const ws = await makeWorkspace();
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/missing.ts",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("outside-workspace wins over ignored when target is outside", async () => {
    const ws = await makeWorkspace({ "/elsewhere/ignored.ts": "" });
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/ignored.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("ignored wins over unsupported", async () => {
    const ws = await inMemoryWorkspace({
      files: {
        "/repo/.git/HEAD": "",
        "/repo/.gitignore": "foo.json\n",
        "/repo/foo.json": "{}",
      },
      startDir: "/repo",
    });
    const router = new BackendRouter([recordingBackend([".ts"]).backend]);
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "foo.json",
      }),
    ).rejects.toBeInstanceOf(IgnoredFileError);
  });
});
