import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { canonicalWorkspaceRoot } from "../helpers/canonical-workspace-root.js";
import { CliDaemonTesting } from "../helpers/daemon-testing.js";
import { DaemonFailureContext } from "../helpers/daemon-failure-context.js";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";

class WarningOptionsHarness {
  private static readonly instances: WarningOptionsHarness[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-warning-options-")));
  public readonly state = join(this.root, "state");
  public readonly workspace = join(this.root, "workspace");

  public constructor() {
    WarningOptionsHarness.instances.push(this);
    cpSync(fixturePath("extraction-diagnostics-cases"), this.workspace, { recursive: true });
    mkdirSync(join(this.workspace, ".git"), { recursive: true });
  }

  public run(argv: readonly string[], daemon = "0", telemetry = "0") {
    return runSymnavBinary(argv, {
      cwd: this.workspace,
      env: {
        SYMNAV_STATE_DIR: this.state,
        SYMNAV_DAEMON: daemon,
        SYMNAV_TELEMETRY: telemetry,
      },
    });
  }

  public events(): readonly { executionMode: string; command: string }[] {
    const path = join(this.state, "usage.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { executionMode: string; command: string });
  }

  public static async cleanup(): Promise<void> {
    for (const harness of this.instances.splice(0)) {
      if (existsSync(harness.state) && statSync(harness.state).isDirectory())
        await E2eProcessCleanup.kill(new CliDaemonTesting(harness.state).processIds());
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
}

afterEach(() => WarningOptionsHarness.cleanup());

const navigation = [
  ["overview", "src/unsupported-statement.ts"],
  ["resolve", "stillVisible"],
  ["def", "stillVisible"],
  ["refs", "stillVisible"],
  ["context", "stillVisible"],
  ["graph", "stillVisible"],
] as const;

describe("global warning options through the built CLI", () => {
  it.each(navigation)("suppresses %s diagnostics at every argument position", (...argv) => {
    const harness = new WarningOptionsHarness();
    const ordinary = harness.run(argv);
    expect(ordinary.status).toBe(0);
    expect(ordinary.stderr).toMatch(/^symnav: warning:/u);
    for (const args of [
      ["--no-warnings", ...argv],
      [argv[0], "--no-warnings", ...argv.slice(1)],
      [...argv, "--no-warnings"],
    ]) {
      expect(harness.run(args)).toEqual({ ...ordinary, stderr: "" });
    }
  });

  it.each([
    ["stats", "--json"],
    ["--help"],
    ["--version"],
    ["overview", "--help"],
    ["daemon", "--help"],
    ["daemon", "status"],
    ["overview", "missing-warning.ts"],
    ["unknown-warning-command"],
  ])("accepts suppression without changing %j output or exit", (...argv) => {
    const harness = new WarningOptionsHarness();
    expect(harness.run(["--no-warnings", ...argv])).toEqual(harness.run(argv));
    expect(harness.run([...argv, "--no-warnings"])).toEqual(harness.run(argv));
  });

  it("preserves literal flag values and terminated arguments", () => {
    const harness = new WarningOptionsHarness();
    const literal = harness.run(["resolve", "--", "--no-warnings"]);
    expect(literal.stderr).toMatch(/^symnav: warning:/u);
    expect(literal.stdout).toContain("--no-warnings");
    writeFileSync(harness.state, "blocked");
    const separate = harness.run(
      ["overview", "src/unsupported-statement.ts", "--at", "--no-warnings"],
      "1",
      "1",
    );
    const attached = harness.run(
      ["overview", "src/unsupported-statement.ts", "--at=--no-warnings"],
      "1",
      "1",
    );
    expect(separate).toEqual(attached);
    expect(separate.stderr).toContain("symnav: warning: cannot write");
    expect(separate.stderr).not.toContain("argument missing");
  });

  it("suppresses denied-state warnings while retaining failures and no telemetry", () => {
    const harness = new WarningOptionsHarness();
    writeFileSync(harness.state, "blocked");
    for (const argv of [
      ["overview", "src/unsupported-statement.ts"],
      ["overview", "missing-warning.ts"],
    ]) {
      const ordinary = harness.run(argv, "1", "1");
      const suppressed = harness.run([...argv, "--no-warnings"], "1", "1");
      expect(ordinary.stderr).toContain("symnav: warning: cannot write");
      expect(suppressed.stdout).toBe(ordinary.stdout);
      expect(suppressed.status).toBe(ordinary.status);
      expect(suppressed.stderr).toBe(
        argv[1] === "missing-warning.ts"
          ? ordinary.stderr.slice(0, ordinary.stderr.indexOf("symnav: warning:"))
          : "",
      );
    }
    expect(readFileSync(harness.state, "utf8")).toBe("blocked");
  });

  it("keeps cold startup, warm telemetry, and daemon ownership with warnings suppressed", async () => {
    const harness = new WarningOptionsHarness();
    const argv = ["overview", "src/unsupported-statement.ts"];
    const cold = harness.run([...argv, "--no-warnings"], "1", "1");
    expect(cold.status).toBe(0);
    expect(cold.stderr).toBe("");
    expect(harness.events().map((event) => event.executionMode)).toEqual(["cold"]);
    expect(harness.run(["daemon", "--no-warnings", "start"], "1").status).toBe(0);
    const testing = new CliDaemonTesting(harness.state);
    const [pid] = testing.processIds();
    expect(pid).toBeGreaterThan(0);
    const ordinary = harness.run(argv, "1", "1");
    expect(ordinary.stderr).toMatch(/^symnav: warning:/u);
    expect(harness.run(["--no-warnings", ...argv], "1", "1")).toEqual({ ...ordinary, stderr: "" });
    expect(testing.processIds()).toEqual([pid]);
    expect(harness.events().map((event) => event.executionMode)).toEqual(["cold", "warm", "warm"]);
    for (const args of [
      ["daemon", "status"],
      ["daemon", "status", "--no-warnings"],
    ]) {
      const status = harness.run(args, "1");
      expect(status.status).toBe(0);
      expect(status.stderr).toBe("");
      expect(status.stdout).toContain(`${canonicalWorkspaceRoot(harness.workspace)}  pid ${pid}`);
      expect(status.stdout).toContain("ready");
    }
    process.kill(pid!, "SIGKILL");
    await E2eProcessCleanup.kill([pid!]);
    const fallback = harness.run([...argv, "--no-warnings"], "1", "1");
    expect(fallback).toEqual(cold);
    expect(harness.events().map((event) => event.executionMode)).toEqual([
      "cold",
      "warm",
      "warm",
      "fallback",
    ]);
    const stopped = harness.run(["daemon", "stop", "--no-warnings"], "1");
    await new DaemonFailureContext({
      stateDirectory: harness.state,
      workspaceRoot: harness.workspace,
      result: stopped,
    }).assert(() => expect(stopped.status).toBe(0));
  }, 20_000);
});
