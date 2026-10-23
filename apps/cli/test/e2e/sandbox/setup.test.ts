import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSymnavBinary } from "@symnav/testing";

class SetupHarness {
  private static readonly roots: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-setup-")));
  public readonly state = join(this.root, "state 雪");
  public readonly codexHome = join(this.root, "codex");
  public readonly configurationPath = join(this.codexHome, "config.toml");
  public readonly bin = join(this.root, "bin");

  public constructor() {
    SetupHarness.roots.push(this.root);
    mkdirSync(this.bin);
  }

  public installed(): void {
    const executable = join(this.bin, process.platform === "win32" ? "codex.EXE" : "codex");
    writeFileSync(executable, "not an agent session");
    chmodSync(executable, 0o700);
  }

  public run(argv: readonly string[], environment: NodeJS.ProcessEnv = {}) {
    return runSymnavBinary(argv, {
      cwd: this.root,
      env: {
        SYMNAV_STATE_DIR: this.state,
        CODEX_HOME: this.codexHome,
        PATH: this.bin,
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
        ...environment,
      },
    });
  }

  public static cleanup(): void {
    for (const root of this.roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => SetupHarness.cleanup());

describe("symnav setup codex", () => {
  it("prints exact grant, restart and already-granted output without creating state", () => {
    const harness = new SetupHarness();
    harness.installed();
    const result = harness.run(["setup", "codex"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `Granted write access to ${harness.state} in ${harness.configurationPath}\nRestart Codex sessions to apply.\n`,
    );
    expect(result.stderr).toBe("");
    expect(existsSync(harness.state)).toBe(false);
    const configuration = readFileSync(harness.configurationPath, "utf8");
    const repeat = harness.run(["setup", "codex"]);
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toBe(
      `Codex already grants write access to ${harness.state} (${harness.configurationPath})\n`,
    );
    expect(readFileSync(harness.configurationPath, "utf8")).toBe(configuration);
  });

  it("writes the grant when the executable is missing and notes absence", () => {
    const harness = new SetupHarness();
    const result = harness.run(["setup", "codex"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `Granted write access to ${harness.state} in ${harness.configurationPath}\nRestart Codex sessions to apply.\nCodex was not found on PATH; the grant applies when installed.\n`,
    );
    expect(result.stderr).toBe("");
    expect(readFileSync(harness.configurationPath, "utf8")).toContain(harness.state);
  });

  it.each([["setup"], ["setup", "codex", "extra"], ["setup", "unknown"]].map((argv) => ({ argv })))(
    "rejects invalid arguments $argv without edits",
    ({ argv }) => {
      const harness = new SetupHarness();
      const before = readdirSync(harness.root);
      const result = harness.run(argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("error:");
      expect(readdirSync(harness.root)).toEqual(before);
    },
  );

  it.each(
    [
      ["--no-warnings", "setup", "codex"],
      ["setup", "--no-warnings", "codex"],
      ["setup", "codex", "--no-warnings"],
    ].map((argv) => ({ argv })),
  )("accepts global warning suppression $argv", ({ argv }) => {
    const harness = new SetupHarness();
    harness.installed();
    expect(harness.run(argv).status).toBe(0);
  });

  it("prints exact invalid-config error with unchanged source and no warnings", () => {
    const harness = new SetupHarness();
    mkdirSync(harness.codexHome);
    const original = "model = 'a'\nmodel = 'b'\n";
    writeFileSync(harness.configurationPath, original);
    const result = harness.run(["setup", "codex", "--no-warnings"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `symnav: error: cannot update ${harness.configurationPath}: invalid TOML at line 2\n`,
    );
    expect(readFileSync(harness.configurationPath, "utf8")).toBe(original);
    expect(existsSync(harness.state)).toBe(false);
  });
  it("grants blocked state without telemetry or project config edits", () => {
    const harness = new SetupHarness();
    harness.installed();
    writeFileSync(harness.state, "blocked state");
    const projectConfig = join(harness.root, ".codex", "config.toml");
    mkdirSync(join(harness.root, ".codex"));
    writeFileSync(projectConfig, "project config stays unchanged");
    const result = harness.run(["setup", "codex"], { SYMNAV_DAEMON: "1", SYMNAV_TELEMETRY: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(harness.state, "utf8")).toBe("blocked state");
    expect(readFileSync(projectConfig, "utf8")).toBe("project config stays unchanged");
    expect(readFileSync(harness.configurationPath, "utf8")).toContain(harness.state);
  });
});
