import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary, type RunSymnavBinaryResult } from "@symnav/testing";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";

type SandboxRuntime = "claude-code" | "codex";

class SandboxNavigationHarness {
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-sandbox-")));
  public readonly stateDirectory = join(this.root, "state");
  public readonly workspace: string;
  public readonly forbiddenTemporaryDirectory = join(this.root, "forbidden-tmp");
  public readonly testing: CliDaemonTesting;
  private readonly children: ChildProcessWithoutNullStreams[] = [];
  private static readonly cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
  private static readonly session = fileURLToPath(
    new URL("../../helpers/sandbox-navigation-session.mjs", import.meta.url),
  );

  public constructor(workspace?: string) {
    this.workspace = workspace ?? join(this.root, "workspace");
    mkdirSync(this.stateDirectory);
    mkdirSync(this.forbiddenTemporaryDirectory);
    if (workspace === undefined)
      cpSync(fixturePath("trivial-project"), this.workspace, { recursive: true });
    mkdirSync(join(this.workspace, ".git"), { recursive: true });
    this.testing = new CliDaemonTesting(this.stateDirectory);
  }

  public environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SYMNAV_STATE_DIR: this.stateDirectory,
      SYMNAV_DAEMON: "1",
      SYMNAV_TELEMETRY: "1",
      TMPDIR: this.forbiddenTemporaryDirectory,
      TMP: this.forbiddenTemporaryDirectory,
      TEMP: this.forbiddenTemporaryDirectory,
    };
  }

  public outside(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = {},
  ): RunSymnavBinaryResult {
    return runSymnavBinary(argv, {
      cwd: this.workspace,
      env: { ...this.environment(), ...environment },
    });
  }

  public async start(runtime: SandboxRuntime): Promise<SandboxNavigationSession> {
    const command = this.command(runtime);
    const child = spawn(command.executable, command.argv, {
      cwd: this.workspace,
      env: {
        ...this.environment(),
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        ...command.environment,
      },
      stdio: "pipe",
    });
    this.children.push(child);
    const session = new SandboxNavigationSession(child);
    await session.ready;
    return session;
  }

  public async waitUntilReady(): Promise<number> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = this.outside(["daemon", "status", "--json"], { SYMNAV_TELEMETRY: "0" });
      if (status.status !== 0) throw new Error(status.stderr);
      const daemons = (JSON.parse(status.stdout) as { daemons: { state: string; pid: number }[] })
        .daemons;
      const ready = daemons.find((daemon) => daemon.state === "ready");
      if (ready !== undefined) return ready.pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Sandbox daemon did not become ready");
  }

  public async permissions(session: SandboxNavigationSession): Promise<unknown> {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing test host listener");
      return await session.request({
        kind: "permissions",
        forbiddenPath: join(this.workspace, "must-not-write"),
        hostPort: address.port,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  public modes(): string[] {
    const path = join(this.stateDirectory, "usage.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { executionMode: string }).executionMode);
  }

  public addLargeSource(): void {
    writeFileSync(
      join(this.workspace, "large.ts"),
      Array.from({ length: 5_000 }, (_, index) => `export const entry${index} = ${index};`).join(
        "\n",
      ),
    );
  }

  public async dispose(): Promise<void> {
    for (const child of this.children) child.stdin.end();
    this.outside(["daemon", "stop"], { SYMNAV_TELEMETRY: "0" });
    await E2eProcessCleanup.terminateAndRemoveDirectories(
      [this.root],
      () => this.testing.processIds(),
      { children: this.children },
    );
  }

  private command(runtime: SandboxRuntime): {
    executable: string;
    argv: string[];
    environment?: NodeJS.ProcessEnv;
  } {
    if (runtime === "claude-code") {
      const settings = join(this.root, "srt-settings.json");
      writeFileSync(
        settings,
        JSON.stringify({
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: {
            denyRead: [],
            allowWrite: [this.stateDirectory],
            denyWrite: [this.workspace, this.forbiddenTemporaryDirectory],
          },
        }),
      );
      const executable = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
      return {
        executable: process.execPath,
        argv: [
          join(dirname(executable), "cli.js"),
          "--settings",
          settings,
          "--",
          process.execPath,
          SandboxNavigationHarness.session,
          SandboxNavigationHarness.cli,
          this.forbiddenTemporaryDirectory,
        ],
      };
    }
    const codexHome = join(this.root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `default_permissions = "symnav-test"\n[permissions.symnav-test]\nextends = ":read-only"\n[permissions.symnav-test.filesystem]\n${JSON.stringify(this.stateDirectory)} = "write"\n[permissions.symnav-test.network]\nenabled = false\n`,
    );
    return {
      executable: "codex",
      environment: { CODEX_HOME: codexHome },
      argv: [
        "sandbox",
        "--permission-profile",
        "symnav-test",
        "-C",
        this.workspace,
        "--",
        process.execPath,
        SandboxNavigationHarness.session,
        SandboxNavigationHarness.cli,
        this.forbiddenTemporaryDirectory,
      ],
    };
  }
}

class SandboxNavigationSession {
  public readonly ready: Promise<unknown>;
  private readonly replies: unknown[] = [];
  private pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  private failure: Error | undefined;
  private stderr = "";

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const value: unknown = JSON.parse(line);
      const pending = this.pending;
      if (pending === undefined) this.replies.push(value);
      else {
        this.pending = undefined;
        pending.resolve(value);
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      this.stderr += bytes.toString();
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code) =>
      this.fail(new Error(`Sandbox exited ${String(code)}: ${this.stderr}`)),
    );
    this.ready = this.next();
  }

  public async run(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = {},
  ): Promise<RunSymnavBinaryResult> {
    return this.request({ kind: "run", argv, environment }) as Promise<RunSymnavBinaryResult>;
  }
  public close(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.stdin.end();
    });
  }

  public async request(value: unknown): Promise<unknown> {
    this.child.stdin.write(JSON.stringify(value) + "\n");
    return this.next();
  }
  private next(): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const queued = this.replies.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  private fail(error: Error): void {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }
}

const supportedPlatform = process.platform === "darwin" || process.platform === "linux";
const required = process.env.SYMNAV_REQUIRE_SANDBOX_RUNTIME === "1";
const linuxAvailable =
  process.platform !== "linux" ||
  ["bwrap", "socat"].every((command) => spawnSync("which", [command]).status === 0);
const sandboxApplication =
  process.platform === "darwin"
    ? spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"])
    : linuxAvailable
      ? spawnSync("bwrap", ["--unshare-user", "--dev-bind", "/", "/", "true"])
      : undefined;
const sandboxApplicationAllowed = sandboxApplication?.status === 0;
const claudeAvailable = supportedPlatform && linuxAvailable && sandboxApplicationAllowed;
const codexAvailable =
  supportedPlatform &&
  sandboxApplicationAllowed &&
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
if (required && !claudeAvailable)
  throw new Error(
    "Required sandbox-runtime needs macOS or Linux with bubblewrap and socat; working sandbox application; this CI job cannot skip",
  );
if (!claudeAvailable)
  console.error(
    "Sandbox runtime skipped: unsupported platform or missing Linux bubblewrap/socat or denied sandbox application",
  );

describe.each([
  ["claude-code", claudeAvailable],
  ["codex", codexAvailable],
] as const)("%s state-only warm navigation", (runtime, available) => {
  const harnesses: SandboxNavigationHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
  });

  it.skipIf(!available)(
    "shares one cold-to-warm daemon with unsandboxed commands without socket or network permission",
    async () => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      const baseline = harness.outside(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      const session = await harness.start(runtime);
      expect(await harness.permissions(session)).toMatchObject({
        writeCode: expect.stringMatching(/EPERM|EACCES|EROFS/),
        unixCode: expect.stringMatching(/EPERM|EACCES/),
        tcpCode: expect.stringMatching(
          /EPERM|EACCES|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/,
        ),
      });
      expect(await session.run(["overview", "src/index.ts"])).toEqual(baseline);
      const pid = await harness.waitUntilReady();
      expect(await session.run(["overview", "src/index.ts"])).toEqual(baseline);
      expect(harness.outside(["overview", "src/index.ts"])).toEqual(baseline);
      expect(
        harness.testing.processIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([pid]);
      expect(harness.modes()).toEqual(["cold", "warm", "warm"]);
      expect(readdirSync(harness.forbiddenTemporaryDirectory)).toEqual([]);
    },
    40_000,
  );

  it.skipIf(!available)(
    "reaches an externally started daemon and spills large output only in state",
    async () => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      harness.addLargeSource();
      const baseline = harness.outside(["overview", "large.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      expect(Buffer.byteLength(baseline.stdout)).toBeGreaterThan(256 * 1024);
      harness.outside(["overview", "src/index.ts"]);
      const pid = await harness.waitUntilReady();
      const session = await harness.start(runtime);
      expect(await session.run(["overview", "large.ts"])).toEqual(baseline);
      expect(
        harness.testing.processIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([pid]);
      await session.close();
      const independentSession = await harness.start(runtime);
      const smallBaseline = harness.outside(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      expect(await independentSession.run(["overview", "src/index.ts"])).toEqual(smallBaseline);
      expect(
        harness.testing.processIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([pid]);
      expect(harness.modes()).toEqual(["cold", "warm", "warm"]);
      expect(readdirSync(join(harness.stateDirectory, "captures"))).toEqual([]);
      expect(readdirSync(harness.forbiddenTemporaryDirectory)).toEqual([]);
    },
    40_000,
  );

  it.skipIf(!available)(
    "elects one owner across independent sandboxes while distinct state roots stay isolated",
    async () => {
      const first = new SandboxNavigationHarness();
      harnesses.push(first);
      const second = new SandboxNavigationHarness(first.workspace);
      harnesses.push(second);
      const baseline = first.outside(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      const sessions = await Promise.all([first.start(runtime), first.start(runtime)]);
      const results = await Promise.all(
        sessions.map((session) => session.run(["overview", "src/index.ts"])),
      );
      expect(results).toEqual([baseline, baseline]);
      const firstPid = await first.waitUntilReady();
      expect(first.testing.processIds()).toEqual([firstPid]);
      const isolated = await second.start(runtime);
      expect(await isolated.run(["overview", "src/index.ts"])).toEqual(baseline);
      const secondPid = await second.waitUntilReady();
      expect(secondPid).not.toBe(firstPid);
      expect(await isolated.run(["overview", "src/index.ts"])).toEqual(baseline);
      expect(first.testing.processIds()).toEqual([firstPid]);
      expect(second.modes()).toEqual(["cold", "warm"]);
    },
    40_000,
  );

  it.skipIf(!available)(
    "runs large local output with both state users disabled and no writable spill path",
    async () => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      harness.addLargeSource();
      const baseline = harness.outside(["overview", "large.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      const session = await harness.start(runtime);
      expect(
        await session.run(["overview", "large.ts"], {
          SYMNAV_DAEMON: "0",
          SYMNAV_TELEMETRY: "0",
          SYMNAV_STATE_DIR: join(harness.workspace, "denied-state"),
        }),
      ).toEqual(baseline);
      expect(readdirSync(harness.stateDirectory)).toEqual([]);
      expect(readdirSync(harness.forbiddenTemporaryDirectory)).toEqual([]);
      expect(existsSync(join(harness.workspace, "denied-state"))).toBe(false);
    },
    40_000,
  );
});
