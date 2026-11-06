import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { runSymnavBinary } from "@symnav/testing";

class CodexSetupRuntimeHarness {
  private static readonly roots: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-codex-runtime-")));
  public readonly workspace = join(this.root, "workspace");
  public readonly state = join(this.root, "state");
  public readonly codexHome = join(this.root, "codex");
  public readonly configurationPath = join(this.codexHome, "config.toml");
  private readonly environment: NodeJS.ProcessEnv;

  public constructor() {
    CodexSetupRuntimeHarness.roots.push(this.root);
    mkdirSync(this.workspace);
    mkdirSync(this.state);
    mkdirSync(this.codexHome);
    this.environment = {
      ...process.env,
      CODEX_HOME: this.codexHome,
      SYMNAV_STATE_DIR: this.state,
      SYMNAV_DAEMON: "0",
      SYMNAV_TELEMETRY: "0",
    };
  }

  public configure(style: "legacy" | "named"): void {
    const configuration =
      style === "legacy"
        ? 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = []\n'
        : `default_permissions = "child"\n[permissions.base]\nextends = ":read-only"\n[permissions.base.filesystem]\n${JSON.stringify(join(this.state, "denied"))} = "deny"\n[permissions.base.network]\nenabled = false\n[permissions.child]\nextends = "base"\n`;
    writeFileSync(this.configurationPath, configuration);
  }

  public configureScoped(style: string): void {
    const key = JSON.stringify(this.state);
    const base =
      style === "child scoped" ? '"write"' : `{ "." = "read", denied = "deny", replaced = "deny" }`;
    const middle = style === "nearest scalar" ? '"read"' : '{ "." = "read", denied = "deny" }';
    writeFileSync(
      this.configurationPath,
      `default_permissions = "child" # selection\n[permissions.base]\nextends = ":read-only"\nfilesystem.${key} = ${base} # ancestor\nnetwork.enabled = false # network\n[permissions.middle]\nextends = "base"\n${style.startsWith("nearest") ? `filesystem.${key} = ${middle} # replacement\n` : ""}[permissions.child]\nextends = "middle"\n${style === "child scoped" ? `filesystem.${key} = ${middle} # child\n` : ""}`,
    );
  }

  public setup(): string {
    const result = runSymnavBinary(["setup", "codex"], {
      cwd: this.workspace,
      env: this.environment,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  public runtime(style: "legacy" | "named", port: number) {
    let profile = "child";
    let environment = this.environment;
    if (style === "legacy") {
      const configuration = getStaticTOMLValue(
        parseTOML(readFileSync(this.configurationPath, "utf8")),
      ) as { sandbox_workspace_write: { writable_roots: string[]; network_access: boolean } };
      const runtimeHome = join(this.root, "runtime-codex");
      mkdirSync(runtimeHome, { recursive: true });
      profile = "legacy-probe";
      const grants = configuration.sandbox_workspace_write.writable_roots
        .map((root) => `${JSON.stringify(root)} = "write"`)
        .join("\n");
      writeFileSync(
        join(runtimeHome, "config.toml"),
        `default_permissions = "${profile}"\n[permissions.${profile}]\nextends = ":read-only"\n[permissions.${profile}.filesystem]\n${grants}\n[permissions.${profile}.network]\nenabled = ${configuration.sandbox_workspace_write.network_access}\n`,
      );
      environment = { ...environment, CODEX_HOME: runtimeHome };
    }
    const script = `
      const fs = require('node:fs'); const net = require('node:net');
      const attempt = (path) => { try { fs.writeFileSync(path, 'probe'); return 'allowed'; } catch (error) { return error.code; } };
      const result = { state: attempt(${JSON.stringify(join(this.state, "allowed"))}), workspace: attempt(${JSON.stringify(join(this.workspace, "blocked"))}), unrelated: attempt(${JSON.stringify(join(this.root, "blocked"))}), denied: attempt(${JSON.stringify(join(this.state, "denied"))}), replaced: attempt(${JSON.stringify(join(this.state, "replaced"))}) };
      const socket = net.connect(${port}, '127.0.0.1'); socket.setTimeout(2000);
      socket.on('connect', () => { result.network = 'allowed'; socket.destroy(); });
      socket.on('error', (error) => { result.network = error.code; });
      socket.on('timeout', () => { result.network = 'timeout'; socket.destroy(); });
      socket.on('close', () => console.log(JSON.stringify(result)));
    `;
    return spawnSync(
      "codex",
      [
        "sandbox",
        "--permission-profile",
        profile,
        "-C",
        this.workspace,
        "--",
        process.execPath,
        "-e",
        script,
      ],
      { cwd: this.workspace, env: environment, encoding: "utf8", timeout: 10_000 },
    );
  }

  public static available(): boolean {
    return (
      spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0 &&
      process.platform !== "win32"
    );
  }

  public static cleanup(): void {
    for (const root of this.roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => CodexSetupRuntimeHarness.cleanup());

describe.skipIf(!CodexSetupRuntimeHarness.available())("installed Codex setup policy", () => {
  it.each(["legacy", "named"] as const)(
    "grants state from edited %s config without broader writes or network",
    async (style) => {
      const harness = new CodexSetupRuntimeHarness();
      harness.configure(style);

      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing listener");
        const before = harness.runtime(style, address.port);
        expect(before.status, before.stderr).toBe(0);
        expect(["EPERM", "EACCES"]).toContain(
          (JSON.parse(before.stdout) as Record<string, string>).state,
        );
        harness.setup();
        const result = harness.runtime(style, address.port);
        expect(result.status, result.stderr).toBe(0);
        const permissions = JSON.parse(result.stdout) as Record<string, string>;
        expect(permissions.state).toBe("allowed");
        expect(["EPERM", "EACCES"]).toContain(permissions.workspace);
        expect(["EPERM", "EACCES"]).toContain(permissions.unrelated);
        expect(["EPERM", "EACCES"]).toContain(permissions.network);
        if (style === "named") expect(["EPERM", "EACCES"]).toContain(permissions.denied);
        else expect(permissions.denied).toBe("allowed");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it.each(["inherited scoped", "child scoped", "nearest scoped", "nearest scalar"])(
    "preserves effective scoped descendants for %s inheritance",
    async (style) => {
      const harness = new CodexSetupRuntimeHarness();
      harness.configureScoped(style);
      const original = readFileSync(harness.configurationPath, "utf8");
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing listener");
        const before = harness.runtime("named", address.port);
        expect(before.status, before.stderr).toBe(0);
        const initial = JSON.parse(before.stdout) as Record<string, string>;
        expect(["EPERM", "EACCES"]).toContain(initial.state);
        expect(["EPERM", "EACCES"]).toContain(initial.denied);
        const output = harness.setup();
        expect(output).not.toContain("already grants");
        const updated = readFileSync(harness.configurationPath, "utf8");
        if (style === "child scoped")
          expect(updated).toBe(original.replace('"read", denied', '"write", denied'));
        else expect(updated.startsWith(original)).toBe(true);
        const result = harness.runtime("named", address.port);
        expect(result.status, result.stderr).toBe(0);
        const permissions = JSON.parse(result.stdout) as Record<string, string>;
        expect(permissions.state).toBe("allowed");
        expect(["EPERM", "EACCES"]).toContain(permissions.workspace);
        expect(["EPERM", "EACCES"]).toContain(permissions.unrelated);
        expect(["EPERM", "EACCES"]).toContain(permissions.network);
        if (style === "nearest scalar") expect(permissions.denied).toBe("allowed");
        else expect(["EPERM", "EACCES"]).toContain(permissions.denied);
        if (style === "inherited scoped" || style === "nearest scoped")
          expect(["EPERM", "EACCES"]).toContain(permissions.replaced);
        else expect(permissions.replaced).toBe("allowed");
        expect(harness.setup()).toContain("already grants");
        expect(readFileSync(harness.configurationPath, "utf8")).toBe(updated);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
