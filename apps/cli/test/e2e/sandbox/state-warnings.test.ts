import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CliDaemonTesting } from "../../helpers/daemon-testing.js";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";

class StateWarningHarness {
  private static readonly roots: string[] = [];
  private static readonly restricted: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-state-warning-")));
  public readonly state = join(this.root, "state");
  public readonly workspace = join(this.root, "workspace");

  public constructor() {
    StateWarningHarness.roots.push(this.root);
    cpSync(fixturePath("trivial-project"), this.workspace, { recursive: true });
    mkdirSync(join(this.workspace, ".git"), { recursive: true });
  }

  public run(argv: readonly string[], environment: NodeJS.ProcessEnv = {}) {
    return runSymnavBinary(argv, {
      cwd: this.workspace,
      env: {
        SYMNAV_STATE_DIR: this.state,
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
        ...environment,
      },
    });
  }

  public forbidStateAccess(): { readonly options: string; readonly marker: string } {
    const guard = join(this.root, "guard.mjs");
    const marker = join(this.root, "state-accessed");
    writeFileSync(
      guard,
      `import fs from 'node:fs';\nimport promises from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\nconst record = fs.writeFileSync;\nfor (const owner of [fs, promises]) {\n  for (const name of ['access', 'exists', 'lstat', 'mkdir', 'open', 'readFile', 'readdir', 'realpath', 'stat', 'writeFile', 'appendFile', 'rm', 'unlink']) {\n    for (const key of [name, name + 'Sync']) {\n      const original = owner[key];\n      if (typeof original !== 'function') continue;\n      owner[key] = Object.assign(function(path, ...args) {\n        if (String(path).startsWith(process.env.SYMNAV_STATE_DIR)) {\n          record(${JSON.stringify(marker)}, key);\n          throw new Error('Unexpected state access: ' + key);\n        }\n        return original.call(this, path, ...args);\n      }, original);\n    }\n  }\n}\nsyncBuiltinESMExports();\n`,
    );
    return { options: `--import=${pathToFileURL(guard).href}`, marker };
  }

  public deny(path: string): void {
    StateWarningHarness.restricted.push(path);
    chmodSync(path, 0o500);
  }

  public denyDirectoryTree(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) this.denyDirectoryTree(join(path, entry.name));
    }
    this.deny(path);
  }

  public warning(osCode: string): string {
    return `symnav: warning: cannot write ${this.state} (${osCode}); daemon and telemetry are off for this command. Grant access with 'symnav setup <agent>', or pass --no-warnings.\n`;
  }

  public static cleanup(): void {
    for (const path of this.restricted) chmodSync(path, 0o700);
    this.restricted.length = 0;
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
    this.roots.length = 0;
  }
}

afterEach(() => StateWarningHarness.cleanup());

describe("symnav required state writes", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "finalizes the state warning after a failed lifecycle write",
    () => {
      const harness = new StateWarningHarness();
      mkdirSync(harness.state);
      harness.deny(harness.state);
      const result = harness.run(["daemon", "start"], { SYMNAV_DAEMON: "1" });
      expect(result.status).toBe(2);
      expect(result.stderr.startsWith("Cannot start daemon:")).toBe(true);
      expect(result.stderr.endsWith(harness.warning("EACCES"))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "finalizes a rejected status cleanup after its ordinary error without replay",
    async () => {
      const harness = new StateWarningHarness();
      const started = harness.run(["daemon", "start", "--json"], { SYMNAV_DAEMON: "1" });
      expect(started.status).toBe(0);
      const inspector = new CliDaemonTesting(harness.state).inspector;
      const instances = inspector.listInstances();
      expect(instances).toHaveLength(1);
      const instance = instances[0]!;
      try {
        await E2eProcessCleanup.kill([instance.pid]);
        harness.denyDirectoryTree(harness.state);
        const result = harness.run(["daemon", "status", "--json"], { SYMNAV_DAEMON: "1" });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("EACCES: permission denied, unlink");
        expect(result.stderr).toContain(harness.state);
        expect(result.stderr.endsWith(harness.warning("EACCES"))).toBe(true);
        expect(result.stderr.split("symnav: warning:")).toHaveLength(2);
        expect(inspector.listInstances()).toEqual(instances);
        expect(existsSync(join(harness.state, "usage.jsonl"))).toBe(false);
      } finally {
        await E2eProcessCleanup.terminate([instance.pid]);
      }
    },
  );

  it.each([
    { daemon: "0", telemetry: "1" },
    { daemon: "1", telemetry: "0" },
    { daemon: "1", telemetry: "1" },
  ])("reports blocked state with daemon=$daemon telemetry=$telemetry", ({ daemon, telemetry }) => {
    const harness = new StateWarningHarness();
    writeFileSync(harness.state, "blocked");
    const baseline = harness.run(["overview", "src/index.ts"]);
    const result = harness.run(["overview", "src/index.ts"], {
      SYMNAV_DAEMON: daemon,
      SYMNAV_TELEMETRY: telemetry,
    });
    expect(result.status).toBe(baseline.status);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stderr).toBe(harness.warning("EEXIST"));
    expect(readdirSync(harness.root).sort()).toEqual(["state", "workspace"]);
  });

  it.each(["usage.jsonl", "captures", "daemons"])(
    "reports a blocked required child %s",
    (child) => {
      const harness = new StateWarningHarness();
      mkdirSync(harness.state);
      const daemon = child === "captures" || child === "daemons";
      if (daemon) writeFileSync(join(harness.state, child), "blocked");
      else mkdirSync(join(harness.state, child));
      const result = harness.run(["overview", "src/index.ts"], {
        SYMNAV_DAEMON: daemon ? "1" : "0",
        SYMNAV_TELEMETRY: daemon ? "0" : "1",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe(harness.warning(daemon ? "EEXIST" : "EISDIR"));
    },
  );

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["root", "parent", "usage.jsonl"])("reports real denied permissions on %s", (target) => {
    const harness = new StateWarningHarness();
    mkdirSync(harness.state);
    if (target === "parent") {
      rmSync(harness.state, { recursive: true });
      harness.deny(harness.root);
    } else if (target === "root") harness.deny(harness.state);
    else {
      writeFileSync(join(harness.state, target), "");
      harness.deny(join(harness.state, target));
    }
    const result = harness.run(["overview", "src/index.ts"], { SYMNAV_TELEMETRY: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(harness.warning("EACCES"));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "records telemetry with an existing read-only machine identity without warning",
    () => {
      const harness = new StateWarningHarness();
      mkdirSync(harness.state);
      const identity = join(harness.state, "machine-id");
      writeFileSync(identity, "existing-identity");
      chmodSync(identity, 0o400);
      const result = harness.run(["overview", "src/index.ts"], { SYMNAV_TELEMETRY: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Overview: src/index.ts");
      expect(readFileSync(identity, "utf8")).toBe("existing-identity");
      const events = readFileSync(join(harness.state, "usage.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ machineId: "existing-identity", command: "overview" });
    },
  );

  it.each(
    [
      ["--help"],
      ["--version"],
      ["stats", "--json"],
      ["daemon", "status", "--json"],
      ["daemon", "stop", "--json"],
    ].map((argv) => ({ argv })),
  )("does not warn when read-only state needs no write: $argv", ({ argv }) => {
    const harness = new StateWarningHarness();
    mkdirSync(harness.state);
    harness.deny(harness.state);
    const result = harness.run(argv, { SYMNAV_DAEMON: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readdirSync(harness.state)).toEqual([]);
  });

  it("preserves a large local result and writes no alternate spill files after denial", () => {
    const harness = new StateWarningHarness();
    const source = Array.from(
      { length: 400 },
      (_, index) => `export const symbol${"x".repeat(700)}${index} = ${index};`,
    ).join("\n");
    writeFileSync(join(harness.workspace, "large.ts"), source);
    writeFileSync(harness.state, "blocked");
    const temporary = join(harness.root, "temporary");
    mkdirSync(temporary);
    const baseline = harness.run(["overview", "large.ts"]);
    const result = harness.run(["overview", "large.ts"], {
      SYMNAV_DAEMON: "1",
      SYMNAV_TELEMETRY: "1",
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
    });
    expect(result.status).toBe(baseline.status);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(256 * 1024);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stderr).toBe(harness.warning("EEXIST"));
    expect(readdirSync(temporary)).toEqual([]);
  });

  it.each(
    [
      ["overview", "src/index.ts"],
      ["--help"],
      ["--version"],
      ["stats", "--json"],
      ["daemon", "status", "--json"],
      ["daemon", "stop", "--json"],
    ].map((argv) => ({ argv })),
  )("does not access state with both opt-outs: $argv", ({ argv }) => {
    const harness = new StateWarningHarness();
    const guard = harness.forbidStateAccess();
    const result = harness.run(argv, { NODE_OPTIONS: guard.options });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(guard.marker)).toBe(false);
    expect(existsSync(harness.state)).toBe(false);
  });
});
