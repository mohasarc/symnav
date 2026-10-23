import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
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
  private readonly sessions: SandboxNavigationSession[] = [];
  private readonly children = new Map<ChildProcess, Promise<RunSymnavBinaryResult>>();
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
    const session = new SandboxNavigationSession(child);
    this.sessions.push(session);
    await session.ready;
    return session;
  }

  public outsideAsync(
    argv: readonly string[],
    script = SandboxNavigationHarness.cli,
    environment: NodeJS.ProcessEnv = {},
  ): Promise<RunSymnavBinaryResult> {
    const child = spawn(process.execPath, [script, ...argv], {
      cwd: this.workspace,
      env: { ...this.environment(), ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<RunSymnavBinaryResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    this.children.set(child, exited);
    return exited;
  }

  public async waitForWorker(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(join(this.stateDirectory, "lifecycle-worker-started"))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Lifecycle fixture worker did not start");
  }

  public async releaseDrainingWorker(): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const status = this.outside(["daemon", "status", "--json"], { SYMNAV_TELEMETRY: "0" });
      const daemons = (JSON.parse(status.stdout) as { daemons: { detail?: string }[] }).daemons;
      if (daemons.some((daemon) => daemon.detail === "draining")) {
        writeFileSync(join(this.stateDirectory, "lifecycle-worker-release"), "released");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Lifecycle fixture daemon did not begin authenticated drain");
  }

  public async waitUntilReady(): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = this.outside(["daemon", "status", "--json"], { SYMNAV_TELEMETRY: "0" });
      if (status.status !== 0) throw new Error(status.stderr);
      const daemons = (JSON.parse(status.stdout) as { daemons: { state: string; pid: number }[] })
        .daemons;
      const ready = daemons.find((daemon) => daemon.state === "ready");
      if (ready !== undefined) {
        const instances = this.testing.inspector
          .listInstances()
          .filter((instance) => instance.state === "ready");
        if (instances.length === 1) return instances[0]!.instanceId;
      }
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

  public instanceIds(): readonly string[] {
    return this.testing.inspector.listInstances().map((instance) => instance.instanceId);
  }

  public async waitForExitedLifetimes(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        this.testing.inspector
          .processLifetimeObservations()
          .every((observation) => observation === "exited")
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Sandbox process lifetime was not proven exited");
  }

  public async dispose(): Promise<void> {
    let stopFailure: Error | undefined;
    try {
      const stopped = this.outside(["daemon", "stop"], { SYMNAV_TELEMETRY: "0" });
      if (stopped.status !== 0) throw new Error(stopped.stderr);
      await this.waitForExitedLifetimes();
    } catch (error) {
      stopFailure = error as Error;
    } finally {
      await Promise.all(this.sessions.map((session) => session.close()));
      for (const [child, exited] of this.children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
      }
    }
    if (stopFailure !== undefined) throw stopFailure;
    await this.waitForExitedLifetimes();
    E2eProcessCleanup.removeDirectories([this.root]);
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
  public readonly exited: Promise<void>;
  private closing: Promise<void> | undefined;
  private readonly replies: unknown[] = [];
  private pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  private failure: Error | undefined;
  private stderr = "";

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once("close", () => resolve()));
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
    script?: string,
  ): Promise<RunSymnavBinaryResult> {
    return this.request({
      kind: "run",
      argv,
      environment,
      script,
    }) as Promise<RunSymnavBinaryResult>;
  }
  public close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    this.child.stdin.end();
    const deadline = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(deadline);
    }
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
      const instanceId = await harness.waitUntilReady();
      expect(await session.run(["overview", "src/index.ts"])).toEqual(baseline);
      expect(harness.outside(["overview", "src/index.ts"])).toEqual(baseline);
      expect(
        harness.instanceIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([instanceId]);
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
      const instanceId = await harness.waitUntilReady();
      const session = await harness.start(runtime);
      expect(await session.run(["overview", "large.ts"])).toEqual(baseline);
      expect(
        harness.instanceIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([instanceId]);
      await session.close();
      const independentSession = await harness.start(runtime);
      const smallBaseline = harness.outside(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      expect(await independentSession.run(["overview", "src/index.ts"])).toEqual(smallBaseline);
      expect(
        harness.instanceIds(),
        JSON.stringify(harness.testing.inspector.readDiagnostics(harness.workspace).events),
      ).toEqual([instanceId]);
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
      const firstInstanceId = await first.waitUntilReady();
      expect(first.instanceIds()).toEqual([firstInstanceId]);
      const isolated = await second.start(runtime);
      expect(await isolated.run(["overview", "src/index.ts"])).toEqual(baseline);
      const secondInstanceId = await second.waitUntilReady();
      expect(secondInstanceId).not.toBe(firstInstanceId);
      expect(await isolated.run(["overview", "src/index.ts"])).toEqual(baseline);
      expect(first.instanceIds()).toEqual([firstInstanceId]);
      expect(second.modes()).toEqual(["cold", "warm"]);
    },
    40_000,
  );

  it.skipIf(!available)(
    "observes wrapper lifetime and replaces only a genuinely terminated daemon",
    async () => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      const baseline = harness.outside(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      });
      expect(baseline).toMatchObject({ status: 0, stderr: "" });
      const session = await harness.start(runtime);
      expect(await session.run(["overview", "src/index.ts"])).toEqual(baseline);
      const original = await harness.waitUntilReady();
      expect(await session.run(["overview", "src/index.ts"])).toEqual(baseline);
      await session.close();
      const lifetimes = harness.testing.inspector.processLifetimeObservations();
      expect(lifetimes.length).toBeGreaterThan(0);
      expect(lifetimes).not.toContain("unknown");
      const exited = lifetimes.every((observation) => observation === "exited");
      if (process.platform === "linux" && runtime === "claude-code") expect(exited).toBe(true);
      const ownershipAfterClose = harness.testing.inspector.listInstances();
      let recoveryMode: "cold" | "fallback" | "warm";
      if (exited && ownershipAfterClose.length === 0) recoveryMode = "cold";
      else {
        expect(ownershipAfterClose).toEqual([
          expect.objectContaining({ instanceId: original, state: "ready" }),
        ]);
        recoveryMode = exited ? "fallback" : "warm";
      }
      expect(harness.outside(["overview", "src/index.ts"])).toEqual(baseline);
      const replacement = await harness.waitUntilReady();
      expect(harness.outside(["overview", "src/index.ts"])).toEqual(baseline);
      if (exited) {
        expect(replacement).not.toBe(original);
      } else {
        expect(replacement).toBe(original);
      }
      expect(harness.modes()).toEqual(["cold", "warm", recoveryMode, "warm"]);
      expect(harness.instanceIds()).toEqual([replacement]);
    },
    40_000,
  );

  it.skipIf(!available).each(["host", "sandbox"] as const)(
    "stops a ready daemon started in %s from the other side",
    async (origin) => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      const session = await harness.start(runtime);
      const start =
        origin === "host"
          ? harness.outside(["overview", "src/index.ts"])
          : await session.run(["overview", "src/index.ts"]);
      expect(start.status).toBe(0);
      const instanceId = await harness.waitUntilReady();
      expect(harness.instanceIds()).toEqual([instanceId]);
      const stopped =
        origin === "host"
          ? await session.run(["daemon", "stop"])
          : harness.outside(["daemon", "stop"]);
      expect(stopped).toEqual({
        status: 0,
        stderr: "",
        stdout: expect.stringMatching(/^Stopped daemon for .+ \(pid \d+\)\n$/),
      });
      await harness.waitForExitedLifetimes();
      const absent =
        origin === "host"
          ? await session.run(["daemon", "stop"])
          : harness.outside(["daemon", "stop"]);
      expect(absent).toEqual({
        status: 0,
        stderr: "",
        stdout: `No daemon running for ${harness.workspace}\n`,
      });
    },
    40_000,
  );

  it.skipIf(!available).each([
    ["host", "graceful"],
    ["sandbox", "graceful"],
    ["host", "blocked"],
    ["sandbox", "blocked"],
  ] as const)(
    "stops %s starting daemon with %s worker through the other side",
    async (origin, worker) => {
      const harness = new SandboxNavigationHarness();
      harnesses.push(harness);
      const session = await harness.start(runtime);
      const fixture = fileURLToPath(
        new URL("../../helpers/daemon-lifecycle-fixture.mjs", import.meta.url),
      );
      const environment: NodeJS.ProcessEnv = { SYMNAV_TEST_STARTING_STOP: worker };
      const launched =
        origin === "host"
          ? await harness.outsideAsync([], fixture, environment)
          : await session.run([], environment, fixture);
      expect(launched).toEqual({ status: 0, stdout: "cold\n", stderr: "" });
      await harness.waitForWorker();
      const instances = harness.testing.inspector.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]?.state).toBe("starting");
      const stopping =
        origin === "host"
          ? session.run(["daemon", "stop"])
          : harness.outsideAsync(["daemon", "stop"]);
      if (worker === "graceful") await harness.releaseDrainingWorker();
      expect(await stopping).toEqual({
        status: 0,
        stderr: "",
        stdout: `${worker === "blocked" ? "Killed" : "Stopped"} daemon for ${harness.workspace} (pid ${instances[0]!.pid})\n`,
      });
      await harness.waitForExitedLifetimes();
      expect(harness.instanceIds()).toEqual([]);
      const absent =
        origin === "host"
          ? await session.run(["daemon", "stop"])
          : harness.outside(["daemon", "stop"]);
      expect(absent).toEqual({
        status: 0,
        stderr: "",
        stdout: `No daemon running for ${harness.workspace}\n`,
      });
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
