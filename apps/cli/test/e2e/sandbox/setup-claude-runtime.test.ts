import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";
import { E2eProcessCleanup } from "../../helpers/e2e-process-cleanup.js";

interface ClaudeSandboxSettings {
  readonly sandbox: {
    readonly enabled: boolean;
    readonly network: { readonly allowedDomains: string[]; readonly deniedDomains: string[] };
    readonly filesystem: {
      readonly allowWrite: string[];
      readonly denyWrite: string[];
      readonly denyRead: string[];
    };
  };
}

class ClaudeSetupRuntimeHarness {
  private static readonly roots: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-claude-runtime-")));
  public readonly workspace = join(this.root, "workspace");
  public readonly state = join(this.root, 'state 雪 "quoted"');
  public readonly claudeHome = join(this.root, "claude");
  public readonly configurationPath = join(this.claudeHome, "settings.json");
  public readonly denied = join(this.state, "denied");
  private readonly secret = join(this.root, "secret");

  public constructor(conflictingDeny: boolean) {
    ClaudeSetupRuntimeHarness.roots.push(this.root);
    mkdirSync(this.workspace);
    mkdirSync(this.state);
    mkdirSync(this.claudeHome);
    writeFileSync(this.secret, "secret");
    writeFileSync(
      this.configurationPath,
      JSON.stringify(
        {
          theme: "unchanged",
          permissions: { deny: ["Edit(/secret)"] },
          sandbox: {
            enabled: false,
            network: { allowedDomains: [], deniedDomains: ["*"] },
            filesystem: {
              allowWrite: [],
              denyWrite: [this.workspace, conflictingDeny ? this.state : this.denied],
              denyRead: [this.secret],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  }

  public settings(): ClaudeSandboxSettings {
    return JSON.parse(readFileSync(this.configurationPath, "utf8")) as ClaudeSandboxSettings;
  }

  public setup(): string {
    const result = runSymnavBinary(["setup", "claude-code"], {
      cwd: this.workspace,
      env: {
        CLAUDE_CONFIG_DIR: this.claudeHome,
        SYMNAV_STATE_DIR: this.state,
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  }

  public runtime() {
    const { sandbox } = this.settings();
    const policy = join(this.root, "runtime-policy.json");
    writeFileSync(
      policy,
      JSON.stringify({ network: sandbox.network, filesystem: sandbox.filesystem }),
    );
    const probe = join(this.root, "probe.cjs");
    writeFileSync(
      probe,
      `
      const fs = require('node:fs');
      const attempt = (path) => { try { fs.writeFileSync(path, 'probe'); return 'allowed'; } catch (error) { return error.code; } };
      const result = {
        state: attempt(${JSON.stringify(join(this.state, "allowed"))}),
        denied: attempt(${JSON.stringify(this.denied)}),
        workspace: attempt(${JSON.stringify(join(this.workspace, "blocked"))}),
        unrelated: attempt(${JSON.stringify(join(this.root, "blocked"))}),
      };
      try { fs.readFileSync(${JSON.stringify(this.secret)}); result.secret = 'allowed'; } catch (error) { result.secret = error.code; }
      console.log(JSON.stringify(result));
    `,
    );
    const executable = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
    const result = spawnSync(
      process.execPath,
      [join(dirname(executable), "cli.js"), "--settings", policy, "--", process.execPath, probe],
      {
        cwd: this.workspace,
        env: { ...process.env, CLAUDE_CONFIG_DIR: this.claudeHome },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(policy, "utf8"))).toEqual({
      network: sandbox.network,
      filesystem: sandbox.filesystem,
    });
    expect(sandbox.network).toEqual({ allowedDomains: [], deniedDomains: ["*"] });
    return JSON.parse(result.stdout) as Record<string, string>;
  }

  public static available(): boolean {
    if (process.platform === "darwin")
      return (
        spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"])
          .status === 0
      );
    if (process.platform !== "linux") return false;
    return (
      ["bwrap", "socat"].every((command) => spawnSync("which", [command]).status === 0) &&
      spawnSync("bwrap", ["--unshare-user", "--dev-bind", "/", "/", "true"]).status === 0
    );
  }

  public static cleanup(): void {
    E2eProcessCleanup.removeDirectories(this.roots.splice(0));
  }
}

afterEach(() => ClaudeSetupRuntimeHarness.cleanup());

const available = ClaudeSetupRuntimeHarness.available();
if (!available && process.env.SYMNAV_REQUIRE_SANDBOX_RUNTIME === "1")
  throw new Error("Required Claude setup sandbox-runtime cannot run on this host");

describe.skipIf(!available)("Claude setup edited policy", () => {
  it.each([false, true])(
    "grants only state while retaining deny rules (conflicting state deny: %s)",
    (conflictingDeny) => {
      const harness = new ClaudeSetupRuntimeHarness(conflictingDeny);
      const original = readFileSync(harness.configurationPath, "utf8");
      const initial = harness.runtime();
      expect(["EPERM", "EACCES"]).toContain(initial.state);
      expect(harness.setup()).toContain("Granted write access");
      const updated = readFileSync(harness.configurationPath, "utf8");
      expect(updated.replace(JSON.stringify(harness.state), "")).toBe(original);
      expect(harness.settings().sandbox.filesystem.allowWrite).toEqual([harness.state]);
      const permissions = harness.runtime();
      if (conflictingDeny) expect(["EPERM", "EACCES"]).toContain(permissions.state);
      else expect(permissions.state).toBe("allowed");
      for (const key of ["denied", "workspace", "unrelated", "secret"])
        expect(["EPERM", "EACCES"]).toContain(permissions[key]);
      expect(harness.setup()).toContain("already grants");
      expect(readFileSync(harness.configurationPath, "utf8")).toBe(updated);
    },
  );
});
