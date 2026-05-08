import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

interface CapturingStream extends Writable {
  text(): string;
}

function capturingStream(): CapturingStream {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as CapturingStream;
  stream.text = () => Buffer.concat(chunks).toString("utf8");
  return stream;
}

class TestExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeExit(): (code: number) => never {
  return (code: number): never => {
    throw new TestExit(code);
  };
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function runOverviewCli(args: readonly string[], cwd: string): Promise<RunResult> {
  const stdout = capturingStream();
  const stderr = capturingStream();
  const exit = makeExit();
  const program = buildProgram({ stdout, stderr, cwd, exit });
  let status = 0;
  try {
    await program.parseAsync(["node", "symnav", ...args]);
  } catch (err) {
    if (err instanceof TestExit) {
      status = err.code;
    } else {
      throw err;
    }
  }
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

let tmpRoot: string;

function makeWorkspace(files: Record<string, string>): string {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(tmpRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, contents);
  }
  return tmpRoot;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "symnav-overview-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("overview subcommand happy path", () => {
  it("writes text-rendered IR to stdout and exits 0", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/x.ts": "export function greet(name: string): string { return name; }\n",
    });
    const r = await runOverviewCli(["overview", "src/x.ts"], tmpRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Overview: src/x.ts");
    expect(r.stdout).toContain("greet");
    expect(r.stdout.endsWith("\n")).toBe(true);
  });

  it("writes JSON to stdout when --json is passed and exits 0", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/x.ts": "export const x = 1;\n",
    });
    const r = await runOverviewCli(["overview", "src/x.ts", "--json"], tmpRoot);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as { filePath: string };
    expect(parsed.filePath).toBe("src/x.ts");
    expect(r.stdout.endsWith("\n")).toBe(true);
  });

  it("global --cwd <dir> overrides the startDir for relative-path resolution", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/sub/y.ts": "export function f(): void {}\n",
    });
    // Run from elsewhere; supply --cwd to point at the workspace subdir.
    const someOtherDir = mkdtempSync(join(tmpdir(), "symnav-elsewhere-"));
    try {
      const r = await runOverviewCli(
        ["--cwd", join(tmpRoot, "src", "sub"), "overview", "y.ts"],
        someOtherDir,
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("Overview: src/sub/y.ts");
    } finally {
      rmSync(someOtherDir, { recursive: true, force: true });
    }
  });
});

describe("overview subcommand user errors", () => {
  it("missing file -> Cannot answer: file not found, exit 1", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
    });
    const r = await runOverviewCli(["overview", "missing.ts"], tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: file not found: missing.ts.\n");
  });

  it("path outside workspace -> Cannot answer: outside workspace, exit 1", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/x.ts": "export const x = 1;\n",
    });
    // Place a file outside the workspace and reference it via an absolute path
    // so root detection still anchors at tmpRoot but the target is outside.
    const outsideDir = mkdtempSync(join(tmpdir(), "symnav-outside-"));
    try {
      const outsidePath = join(outsideDir, "y.ts");
      writeFileSync(outsidePath, "export const y = 2;\n");
      const r = await runOverviewCli(["overview", outsidePath], tmpRoot);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^Cannot answer: .* is outside the workspace rooted at .*\.\n$/);
      expect(r.stderr).toContain(outsidePath);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("ignored file -> Cannot answer: ignored by .gitignore, exit 1", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".gitignore": "ignored.ts\n",
      "ignored.ts": "export const z = 3;\n",
    });
    const r = await runOverviewCli(["overview", "ignored.ts"], tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: ignored.ts is ignored by .gitignore.\n");
  });

  it("unsupported extension -> Cannot answer: not supported, exit 1", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "package.json": "{}\n",
    });
    const r = await runOverviewCli(["overview", "package.json"], tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Cannot answer: .json files are not supported.\n");
  });

  it("no .git in or above cwd -> Cannot answer: not in a git workspace, exit 1", async () => {
    // Note: tmpRoot has no `.git` here.
    writeFileSync(join(tmpRoot, "x.ts"), "export const x = 1;\n");
    const r = await runOverviewCli(["overview", "x.ts"], tmpRoot);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Cannot answer: not in a git workspace .*\.\n$/);
  });

  it("an unexpected internal error exits 2 with the error on stderr", async () => {
    makeWorkspace({
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/x.ts": "export const x = 1;\n",
    });
    const exploding: import("@symnav/core").LanguageBackend = {
      accepts: (p) => p.endsWith(".ts"),
      async fileSymbols(): Promise<never> {
        throw new Error("kaboom");
      },
    };
    const stdout = capturingStream();
    const stderr = capturingStream();
    let status = 0;
    try {
      const program = buildProgram({
        stdout,
        stderr,
        cwd: tmpRoot,
        exit: makeExit(),
        backendsFor: () => [exploding],
      });
      await program.parseAsync(["node", "symnav", "overview", "src/x.ts"]);
    } catch (err) {
      if (err instanceof TestExit) {
        status = err.code;
      } else {
        throw err;
      }
    }
    expect(status).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("kaboom");
  });
});
