import { describe, expect, it } from "vitest";

import { BackendRouter } from "./backend-router.js";
import { UnsupportedFileError } from "./errors.js";
import type { LanguageBackend } from "./language-backend.js";
import type { OverviewFileEntries } from "../intermediate-representation/overview-tree.js";
import type { ResolvedPath, WorkspaceFile, WorkspaceSnapshot } from "../workspace/workspace.js";

interface FakeBackend extends LanguageBackend {
  readonly label: string;
  readonly refreshCalls: readonly unknown[];
  readonly releaseCalls: number;
}

function fakeBackend(
  label: string,
  accepts: (path: string) => boolean,
  refreshResult = { added: 0, changed: 0, removed: 0, unchanged: 0 },
): FakeBackend {
  const refreshCalls: unknown[] = [];
  let releaseCalls = 0;
  return {
    label,
    refreshCalls,
    get releaseCalls() {
      return releaseCalls;
    },
    accepts,
    refresh(request) {
      refreshCalls.push(request);
      return Promise.resolve(refreshResult);
    },
    releaseTransientResources() {
      releaseCalls += 1;
      return Promise.resolve();
    },
    fileEntries(path: ResolvedPath): Promise<OverviewFileEntries> {
      return Promise.resolve({ file: path.relative, entries: [] });
    },
    resolveSymbols() {
      return Promise.resolve([]);
    },
    declarations() {
      return Promise.resolve([]);
    },
    findDefinitions() {
      return Promise.resolve([]);
    },
    findReferences() {
      return Promise.resolve([]);
    },
    findCallTarget() {
      return Promise.resolve({ outcome: "not-found" });
    },
    findCallees() {
      return Promise.resolve([]);
    },
    findCallers() {
      return Promise.resolve([]);
    },
  };
}

describe("BackendRouter", () => {
  it("refreshes each backend once with accepted files and aggregates counts", async () => {
    const tsBackend = fakeBackend("ts", (path) => path.endsWith(".ts"), {
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 1,
    });
    const pyBackend = fakeBackend("py", (path) => path.endsWith(".py"), {
      added: 0,
      changed: 1,
      removed: 1,
      unchanged: 0,
    });
    const unusedBackend = fakeBackend("unused", () => false);
    const router = new BackendRouter([tsBackend, pyBackend, unusedBackend]);
    const snapshot: WorkspaceSnapshot = {
      root: "/repo",
      files: [workspaceFile("src/a.ts"), workspaceFile("src/b.py"), workspaceFile("README.md")],
    };

    await expect(router.refresh(snapshot)).resolves.toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      unchanged: 1,
    });
    expect(tsBackend.refreshCalls).toEqual([
      { snapshot: { root: "/repo", files: [snapshot.files[0]] }, coverage: "workspace" },
    ]);
    expect(pyBackend.refreshCalls).toEqual([
      { snapshot: { root: "/repo", files: [snapshot.files[1]] }, coverage: "workspace" },
    ]);
    expect(unusedBackend.refreshCalls).toEqual([
      { snapshot: { root: "/repo", files: [] }, coverage: "workspace" },
    ]);
  });

  it("assigns overlapping files to the first accepting backend", async () => {
    const first = fakeBackend("first", () => true);
    const second = fakeBackend("second", () => true);
    const router = new BackendRouter([first, second]);
    const file = workspaceFile("src/a.ts");

    await router.refresh({ root: "/repo", files: [file] });

    expect(first.refreshCalls).toEqual([
      { snapshot: { root: "/repo", files: [file] }, coverage: "workspace" },
    ]);
    expect(second.refreshCalls).toEqual([
      { snapshot: { root: "/repo", files: [] }, coverage: "workspace" },
    ]);
  });

  it("preserves selection coverage and canonical root for every backend", async () => {
    const tsBackend = fakeBackend("ts", (path) => path.endsWith(".ts"));
    const pyBackend = fakeBackend("py", (path) => path.endsWith(".py"));
    const router = new BackendRouter([tsBackend, pyBackend]);
    const file = workspaceFile("src/a.ts");

    await router.refresh({ root: "/canonical/repo", files: [file] }, "selection");

    expect(tsBackend.refreshCalls).toEqual([
      {
        snapshot: { root: "/canonical/repo", files: [file] },
        coverage: "selection",
      },
    ]);
    expect(pyBackend.refreshCalls).toEqual([
      {
        snapshot: { root: "/canonical/repo", files: [] },
        coverage: "selection",
      },
    ]);
  });

  it("releases transient resources on every backend", async () => {
    const first = fakeBackend("first", () => true);
    const second = fakeBackend("second", () => true);
    const router = new BackendRouter([first, second]);

    await (
      router as BackendRouter & { releaseTransientResources(): Promise<void> }
    ).releaseTransientResources();

    expect(first.releaseCalls).toBe(1);
    expect(second.releaseCalls).toBe(1);
  });

  it("returns the first backend whose accepts() is true", () => {
    const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
    const pyBackend = fakeBackend("py", (p) => p.endsWith(".py"));
    const router = new BackendRouter([tsBackend, pyBackend]);

    const found = router.find("foo.ts") as ReturnType<typeof fakeBackend> | undefined;
    expect(found?.label).toBe("ts");
  });

  it("returns undefined when no backend accepts the path", () => {
    const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
    const router = new BackendRouter([tsBackend]);

    expect(router.find("foo.json")).toBeUndefined();
  });

  it("preserves registration order on tie", () => {
    const first = fakeBackend("first", () => true);
    const second = fakeBackend("second", () => true);
    const router = new BackendRouter([first, second]);

    const found = router.find("anything.ts") as ReturnType<typeof fakeBackend> | undefined;
    expect(found?.label).toBe("first");
  });

  describe("findOrThrow", () => {
    it("returns the accepting backend (same as find)", () => {
      const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
      const router = new BackendRouter([tsBackend]);

      const found = router.findOrThrow("foo.ts") as ReturnType<typeof fakeBackend>;
      expect(found.label).toBe("ts");
    });

    it("throws UnsupportedFileError when no backend accepts", () => {
      const tsBackend = fakeBackend("ts", (p) => p.endsWith(".ts"));
      const router = new BackendRouter([tsBackend]);

      try {
        router.findOrThrow("foo.json");
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedFileError);
        expect((err as UnsupportedFileError).reason).toContain("foo.json");
      }
    });
  });
});

function workspaceFile(relative: string): WorkspaceFile {
  return {
    relative,
    absolute: `/repo/${relative}`,
    metadata: { size: 10, modifiedAtMs: 100, changeToken: "revision-1" },
  };
}
