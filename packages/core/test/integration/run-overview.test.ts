import { describe, expect, it } from "vitest";
import {
  BackendRouter,
  FileNotFoundError,
  type FileSymbols,
  IgnoredFileError,
  type LanguageBackend,
  OutsideWorkspaceError,
  runOverview,
  UnsupportedFileError,
} from "@symnav/core";
import { InMemoryWorkspace } from "../helpers/in-memory-workspace.js";

const SAMPLE_IR: FileSymbols = {
  filePath: "src/x.ts",
  symbols: [],
};

interface RecordingFake {
  backend: LanguageBackend;
  calls: { filePath: string }[];
}

function recordingBackend(opts: {
  accepts: (filePath: string) => boolean;
  ir?: FileSymbols;
}): RecordingFake {
  const calls: { filePath: string }[] = [];
  const backend: LanguageBackend = {
    accepts: opts.accepts,
    async fileSymbols(filePath: string): Promise<FileSymbols> {
      calls.push({ filePath });
      return opts.ir ?? { filePath, symbols: [] };
    },
  };
  return { backend, calls };
}

describe("runOverview happy path", () => {
  it("returns the backend's IR for a relative input path", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({
      accepts: (p) => p.endsWith(".ts"),
      ir: SAMPLE_IR,
    });
    const router = new BackendRouter([fake.backend]);

    const ir = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "src/x.ts",
    });

    expect(ir).toEqual(SAMPLE_IR);
  });

  it("accepts an absolute input path and returns the IR", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true, ir: SAMPLE_IR });
    const router = new BackendRouter([fake.backend]);

    const ir = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/x.ts",
    });

    expect(ir).toEqual(SAMPLE_IR);
  });

  it("resolves relative paths against cwd, not the workspace root", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/sub/x.ts": "export const x = 1;\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    await runOverview({
      workspace: ws,
      router,
      cwd: "/repo/pkg/sub",
      inputPath: "x.ts",
    });

    expect(fake.calls).toEqual([{ filePath: "pkg/sub/x.ts" }]);
  });

  it("invokes the backend with the workspace-relative POSIX path", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/pkg/a/b/file.ts": "export {};\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "/repo/pkg/a/b/file.ts",
    });

    expect(fake.calls).toEqual([{ filePath: "pkg/a/b/file.ts" }]);
  });
});

describe("runOverview validation errors", () => {
  it("throws FileNotFoundError when the file does not exist", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    const error = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "src/missing.ts",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FileNotFoundError);
    expect(error).toMatchObject({ displayedPath: "src/missing.ts" });
    expect(fake.calls).toEqual([]);
  });

  it("preserves the absolute input as displayed path on missing", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    const error = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "/repo/src/missing.ts",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FileNotFoundError);
    expect(error).toMatchObject({ displayedPath: "/repo/src/missing.ts" });
  });

  it("throws OutsideWorkspaceError when the path resolves outside the workspace", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/x.ts": "",
        "/elsewhere/y.ts": "",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/y.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("throws IgnoredFileError when the path is .gitignored", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/\n",
        "/repo/dist/x.ts": "",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    const error = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "dist/x.ts",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(IgnoredFileError);
    expect(error).toMatchObject({ displayedPath: "dist/x.ts" });
  });

  it("throws UnsupportedFileError when no backend accepts the file", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/data.json": "{}",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: (p) => p.endsWith(".ts") });
    const router = new BackendRouter([fake.backend]);

    const error = await runOverview({
      workspace: ws,
      router,
      cwd: "/repo",
      inputPath: "data.json",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnsupportedFileError);
    expect(error).toMatchObject({
      displayedPath: "data.json",
      extension: ".json",
    });
  });
});

describe("runOverview validation order: missing > outside > ignored > unsupported", () => {
  it("missing wins over outside (path is outside AND missing)", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    // /elsewhere/missing.ts: file doesn't exist AND it's outside the workspace
    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/missing.ts",
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("outside wins over ignored (a path outside the workspace cannot also be ignored)", async () => {
    // We construct the case as: existing file outside workspace; ignore matcher
    // would not apply because the path isn't a workspace-relative path.
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "x.ts\n",
        "/elsewhere/x.ts": "",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: () => true });
    const router = new BackendRouter([fake.backend]);

    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "/elsewhere/x.ts",
      }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("ignored wins over unsupported (ignored .json file inside workspace)", async () => {
    const ws = await InMemoryWorkspace.create({
      files: {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.gitignore": "dist/\n",
        "/repo/dist/data.json": "{}",
      },
      startDir: "/repo",
    });
    const fake = recordingBackend({ accepts: (p) => p.endsWith(".ts") });
    const router = new BackendRouter([fake.backend]);

    await expect(
      runOverview({
        workspace: ws,
        router,
        cwd: "/repo",
        inputPath: "dist/data.json",
      }),
    ).rejects.toBeInstanceOf(IgnoredFileError);
  });
});
