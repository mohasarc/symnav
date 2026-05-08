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

async function runOverviewCli(
  args: readonly string[],
  cwd: string,
): Promise<RunResult> {
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
