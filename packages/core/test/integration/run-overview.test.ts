import { describe, expect, it } from "vitest";
import {
  BackendRouter,
  type FileSymbols,
  type LanguageBackend,
  runOverview,
} from "@symnav/core";
import { inMemoryWorkspace } from "@symnav/testing";

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
    const ws = await inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
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
    const ws = await inMemoryWorkspace({
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
