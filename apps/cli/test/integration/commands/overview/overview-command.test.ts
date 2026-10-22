import { describe, expect, it } from "vitest";
import {
  InMemoryFileSystem,
  type OverviewExpansionResult,
  type OverviewFileEntries,
  WorkspaceSession,
} from "@symnav/core";
import { TypeScriptBackend } from "@symnav/backend-typescript";
import { buildProgram } from "../../../../src/program.js";
import { FakeLanguageBackend } from "../helpers/fake-language-backend.js";
import { fakeDependencies } from "../helpers/fake-program-dependencies.js";
import { createFakeProgramContext } from "../helpers/fake-program-context.js";

async function parse(
  argv: readonly string[],
  deps: Parameters<typeof buildProgram>[1],
  cwd = "/repo",
): Promise<{
  stdout: string;
  stderr: string;
  exitCodes: readonly number[];
}> {
  const context = createFakeProgramContext({ cwd });
  const program = buildProgram(context, deps);
  await program.parseAsync([...argv], { from: "user" });
  return {
    stdout: context.stdout.text(),
    stderr: context.stderr.text(),
    exitCodes: context.exitCodes,
  };
}

class UnreadableSiblingFileSystem extends InMemoryFileSystem {
  unreadableDirectoryReads = 0;

  override async listDir(absPath: string): Promise<readonly string[]> {
    if (absPath === "/repo/private") {
      this.unreadableDirectoryReads += 1;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return super.listDir(absPath);
  }
}

class UnreadableTypeScriptSiblingFileSystem extends InMemoryFileSystem {
  readonly typescriptSourceReads: string[] = [];
  unreadableSourceReads = 0;

  override readFileSync(absPath: string): string {
    if (absPath.endsWith(".ts")) {
      this.typescriptSourceReads.push(absPath);
    }
    if (absPath === "/repo/src/unreadable.ts") {
      this.unreadableSourceReads += 1;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return super.readFileSync(absPath);
  }
}

class UnreadableSiblingMetadataFileSystem extends InMemoryFileSystem {
  siblingMetadataReads = 0;

  override async metadata(absPath: string) {
    if (absPath === "/repo/src/unreadable.ts") {
      this.siblingMetadataReads += 1;
      throw Object.assign(new Error("metadata permission denied"), { code: "EACCES" });
    }
    return super.metadata(absPath);
  }
}

class UnexpectedSiblingDirectoryFileSystem extends InMemoryFileSystem {
  override async listDir(absPath: string): Promise<readonly string[]> {
    if (absPath === "/repo/private") {
      throw Object.assign(new Error("device failure"), { code: "EIO" });
    }
    return super.listDir(absPath);
  }
}

class RetainedSiblingMetadataFileSystem extends InMemoryFileSystem {
  siblingMetadataReads = 0;
  readonly typescriptSourceReads: string[] = [];
  private siblingMetadataFails = false;

  constructor(
    files: Record<string, string>,
    private readonly siblingPath: string,
  ) {
    super(files);
  }

  failSiblingMetadata(): void {
    this.siblingMetadataFails = true;
    this.siblingMetadataReads = 0;
    this.typescriptSourceReads.length = 0;
  }

  override async metadata(absPath: string) {
    if (absPath.startsWith(this.siblingPath)) {
      this.siblingMetadataReads += 1;
      if (this.siblingMetadataFails) {
        throw new Error("unrelated metadata failure");
      }
    }
    return super.metadata(absPath);
  }

  override readFileSync(absPath: string): string {
    if (absPath.endsWith(".ts")) this.typescriptSourceReads.push(absPath);
    return super.readFileSync(absPath);
  }
}

describe("symnav overview happy path", () => {
  it("reads an accessible target when an unrelated sibling directory is unreadable", async () => {
    const fs = new UnreadableSiblingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/private/hidden.ts": "export const hidden = true;\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
    });
    const backend = new FakeLanguageBackend();

    const result = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(result.stdout).toContain("src/a.ts");
    expect(backend.refreshCalls[0]?.snapshot.files.map((file) => file.relative)).toEqual([
      "src/a.ts",
    ]);
    expect(fs.unreadableDirectoryReads).toBe(0);
  });

  it("does not read an unrelated TypeScript sibling while preparing overview", async () => {
    const fs = new UnreadableTypeScriptSiblingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
      "/repo/src/unreadable.ts": "export const unreadable = true;\n",
    });
    const backend = new TypeScriptBackend(fs);

    const result = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(result.stdout).toContain("accessible");
    expect(fs.unreadableSourceReads).toBe(0);
    expect(fs.typescriptSourceReads).toEqual(["/repo/src/a.ts"]);
  });

  it("does not stat an unrelated TypeScript sibling while preparing overview", async () => {
    const fs = new UnreadableSiblingMetadataFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
      "/repo/src/unreadable.ts": "export const unreadable = true;\n",
    });
    const backend = new TypeScriptBackend(fs);

    const result = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
    expect(result.stdout).toContain("accessible");
    expect(fs.siblingMetadataReads).toBe(0);
  });

  it("matches cold overview after an unrelated retained sibling starts failing", async () => {
    const fs = new RetainedSiblingMetadataFileSystem(
      {
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/a.ts": "export const accessible = true;\n",
        "/repo/src/unreadable.ts": "export const unreadable = true;\n",
      },
      "/repo/src/unreadable.ts",
    );
    const coldBackend = new TypeScriptBackend(fs);
    const cold = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [coldBackend] }),
    );
    const retainedBackend = new TypeScriptBackend(fs);
    const workspaceSession = new WorkspaceSession({
      fileSystem: fs,
      backends: [retainedBackend],
      discoveryRetention: "session",
    });
    await workspaceSession.openWorkspace("/repo", "workspace");
    fs.failSiblingMetadata();

    const warm = await parse(["overview", "src/a.ts"], {
      ...fakeDependencies({ fs, backends: () => [retainedBackend] }),
      workspaceSession,
    });

    expect(warm).toEqual(cold);
    expect(fs.siblingMetadataReads).toBe(0);
  });

  it.each([
    {
      target: "src/target.ts",
      stdoutContains: "target",
      stderr: "",
      exitCodes: [] as readonly number[],
      sourceReads: ["/repo/src/target.ts"],
    },
    {
      target: "src/missing.ts",
      stdoutContains: undefined,
      stderr: "Cannot answer: file not found: src/missing.ts.\n",
      exitCodes: [1] as readonly number[],
      sourceReads: [] as readonly string[],
    },
  ])(
    "keeps $target handling isolated from 4,000 retained siblings",
    async ({ target, stdoutContains, stderr, exitCodes, sourceReads }) => {
      const siblings = Object.fromEntries(
        Array.from({ length: 4_000 }, (_, index) => [
          `/repo/siblings/file-${index}.ts`,
          `export const sibling${index} = ${index};\n`,
        ]),
      );
      const fs = new RetainedSiblingMetadataFileSystem(
        {
          "/repo/.git/HEAD": "ref: refs/heads/main\n",
          "/repo/src/target.ts": "export const target = true;\n",
          ...siblings,
        },
        "/repo/siblings/",
      );
      const backend = new TypeScriptBackend(fs);
      const workspaceSession = new WorkspaceSession({
        fileSystem: fs,
        backends: [backend],
        discoveryRetention: "session",
      });
      await workspaceSession.openWorkspace("/repo", "workspace");
      fs.failSiblingMetadata();

      const result = await parse(["overview", target], {
        ...fakeDependencies({ fs, backends: () => [backend] }),
        workspaceSession,
      });

      if (stdoutContains === undefined) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stdout).toContain(stdoutContains);
      }
      expect(result.stderr).toBe(stderr);
      expect(result.exitCodes).toEqual(exitCodes);
      expect(fs.siblingMetadataReads).toBe(0);
      expect(fs.typescriptSourceReads).toEqual(sourceReads);
    },
  );

  it("writes text-rendered IR to stdout with exit 0", async () => {
    const entries: OverviewFileEntries = {
      file: "src/a.ts",
      entries: [
        {
          type: "symbol",
          identity: { file: "src/a.ts", segments: [{ name: "greet" }] },
          kind: { role: "callable", nativeLabel: "function" },
          range: { startLine: 1, endLine: 1 },
          header: { startLine: 1, lines: ["function greet(): void"] },
          children: [],
        },
      ],
    };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export function greet(): void {}\n",
    });
    const backend = new FakeLanguageBackend({ entries: () => entries });

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stdout).toContain("greet");
  });

  it("writes JSON output with --json flag", async () => {
    const entries: OverviewFileEntries = { file: "src/a.ts", entries: [] };
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend({ entries: () => entries });

    const r = await parse(
      ["overview", "src/a.ts", "--json"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    const parsed = JSON.parse(r.stdout) as OverviewExpansionResult;
    expect(parsed).toEqual({
      ...entries,
      request: { depth: 0 },
    });
  });

  it("--cwd overrides startDir for root detection and relative-path resolution", async () => {
    const fs = new InMemoryFileSystem({
      "/other/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/repo/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["--cwd", "/other/repo", "overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
      "/unrelated",
    );

    expect(r.stderr).toBe("");
    expect(r.exitCodes).toEqual([]);
    expect(backend.calls).toEqual(["src/a.ts"]);
  });
});

describe("symnav overview user errors", () => {
  it("preserves target validation when an unrelated sibling directory is unreadable", async () => {
    const fs = new UnreadableSiblingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/private/hidden.ts": "export const hidden = true;\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
    });

    const result = await parse(["overview", "src/missing.ts"], fakeDependencies({ fs }));

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(fs.unreadableDirectoryReads).toBe(0);
  });

  it("validates a missing target before reading an unrelated TypeScript sibling", async () => {
    const fs = new UnreadableTypeScriptSiblingFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
      "/repo/src/unreadable.ts": "export const unreadable = true;\n",
    });
    const backend = new TypeScriptBackend(fs);

    const result = await parse(
      ["overview", "src/missing.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(fs.unreadableSourceReads).toBe(0);
    expect(fs.typescriptSourceReads).toEqual([]);
  });

  it("validates a missing target without statting an unrelated TypeScript sibling", async () => {
    const fs = new UnreadableSiblingMetadataFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
      "/repo/src/unreadable.ts": "export const unreadable = true;\n",
    });

    const result = await parse(["overview", "src/missing.ts"], fakeDependencies({ fs }));

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(result.exitCodes).toEqual([1]);
    expect(fs.siblingMetadataReads).toBe(0);
  });

  it("does not visit an unexpectedly failing sibling directory", async () => {
    const fs = new UnexpectedSiblingDirectoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/private/hidden.ts": "export const hidden = true;\n",
      "/repo/src/a.ts": "export const accessible = true;\n",
    });

    const result = await parse(["overview", "src/a.ts"], fakeDependencies({ fs }));

    expect(result.stdout).toContain("src/a.ts");
    expect(result.stderr).toBe("");
    expect(result.exitCodes).toEqual([]);
  });

  it("writes the file-not-found line to stderr with exit 1 for a missing file", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "src/missing.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: file not found: src/missing.ts.\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the outside-workspace line for a path outside the workspace", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/other/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "/other/src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Cannot answer: /other/src/a.ts is outside the workspace rooted at /repo.\n",
    );
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the ignored line for an ignored path", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "build/\n",
      "/repo/build/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "build/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: build/a.ts is ignored by .gitignore.\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the unsupported-extension line citing .json for a .json file", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/data.json": "{}\n",
    });
    const backend = new FakeLanguageBackend({ accept: () => false });

    const r = await parse(
      ["overview", "data.json"],
      fakeDependencies({
        fs,
        backends: () => [backend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: cannot read .json files (data.json).\n");
    expect(r.exitCodes).toEqual([1]);
  });

  it("writes the no-workspace line when there is no .git in or above cwd", async () => {
    const fs = new InMemoryFileSystem({
      "/loose/src/a.ts": "export const x = 1;\n",
    });
    const backend = new FakeLanguageBackend();

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({ fs, backends: () => [backend] }),
      "/loose",
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "Cannot answer: not in a git workspace (no .git found in or above /loose).\n",
    );
    expect(r.exitCodes).toEqual([1]);
  });

  it("exits 2 and writes the message to stderr for an unexpected internal error", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const x = 1;\n",
    });
    const throwingBackend = new FakeLanguageBackend({
      entries: () => {
        throw new Error("backend went sideways");
      },
    });

    const r = await parse(
      ["overview", "src/a.ts"],
      fakeDependencies({
        fs,
        backends: () => [throwingBackend],
      }),
    );

    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("backend went sideways\n");
    expect(r.exitCodes).toEqual([2]);
  });
});
