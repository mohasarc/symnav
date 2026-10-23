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

class DoctorHarness {
  public static readonly roots: string[] = [];
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "symnav-doctor-")));
  public readonly state = join(
    this.root,
    process.platform === "win32" ? "state 雪" : 'state 雪 "quoted"',
  );
  public readonly codex = join(this.root, "codex");
  public readonly claude = join(this.root, "claude");
  public readonly bin = join(this.root, "bin");
  public constructor() {
    DoctorHarness.roots.push(this.root);
    mkdirSync(this.bin);
    mkdirSync(this.codex);
    mkdirSync(this.claude);
  }
  public installed(name: string): void {
    const path = join(this.bin, process.platform === "win32" ? `${name}.EXE` : name);
    writeFileSync(path, "not an authenticated agent session");
    chmodSync(path, 0o700);
  }
  public configure(granted = true, denied = false): string {
    const path = join(this.claude, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "keep",
        sandbox: {
          enabled: false,
          filesystem: {
            allowWrite: granted ? [this.root] : [],
            denyWrite: denied ? [this.state] : [],
          },
        },
      }),
    );
    return path;
  }
  public run(argv: readonly string[], environment: NodeJS.ProcessEnv = {}) {
    return runSymnavBinary(argv, {
      cwd: this.root,
      env: {
        PATH: this.bin,
        CODEX_HOME: this.codex,
        CLAUDE_CONFIG_DIR: this.claude,
        SYMNAV_STATE_DIR: this.state,
        SYMNAV_DAEMON: "0",
        SYMNAV_TELEMETRY: "0",
        ...environment,
      },
    });
  }
}
afterEach(() => {
  for (const root of DoctorHarness.roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("symnav doctor", () => {
  it("prints deterministic padded skip lines and creates no retained state artifacts", () => {
    const h = new DoctorHarness();
    expect(h.run(["doctor"])).toEqual({
      status: 0,
      stderr: "",
      stdout: "codex        skip  not installed\nclaude-code  skip  not installed\n",
    });
    expect(readdirSync(h.state)).toEqual([]);
  });
  it("uses a custom Claude config root and original parent grant for truthful config-only output", () => {
    const h = new DoctorHarness();
    h.installed("claude");
    const path = h.configure();
    const original = readFileSync(path, "utf8");
    expect(h.run(["doctor", "claude-code"])).toEqual({
      status: 0,
      stderr: "",
      stdout: `claude-code  ok    configuration grants ${h.state}; live sandbox check skipped: ${process.platform === "win32" ? "sandbox runtime cannot be run from the command line" : "sandbox runtime not found"}\n`,
    });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(h.state)).toEqual([]);
    expect(existsSync(join(h.state, "usage.jsonl"))).toBe(false);
  });
  it.each([false, true])(
    "fails missing/denied grants even without live runtime: denied %s",
    (denied) => {
      const h = new DoctorHarness();
      h.installed("claude");
      h.configure(denied, denied);
      expect(h.run(["doctor", "claude-code"])).toEqual({
        status: 1,
        stderr: "",
        stdout: `claude-code  fail  sandbox denies write to ${h.state}; run 'symnav setup claude-code'\n`,
      });
    },
  );
  it.each([
    ["--no-warnings", "doctor", "claude-code"],
    ["doctor", "--no-warnings", "claude-code"],
    ["doctor", "claude-code", "--no-warnings"],
  ])("keeps diagnostic results with warning suppression: %s", (...argv) => {
    const h = new DoctorHarness();
    h.installed("claude");
    h.configure(false);
    const result = h.run(argv);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("claude-code  fail  sandbox denies write");
    expect(result).toEqual(h.run(["doctor", "claude-code"]));
  });
  it.each([
    ["doctor", "unknown"],
    ["doctor", "codex", "extra"],
    ["doctor", "codex", "claude-code"],
  ])("rejects invalid optional agent arguments: %s", (...argv) => {
    const h = new DoctorHarness();
    const result = h.run(argv);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(existsSync(h.state)).toBe(false);
  });
  it("reports doctor state write failure as an unsuppressed error", () => {
    const h = new DoctorHarness();
    writeFileSync(h.state, "");
    for (const argv of [["doctor"], ["doctor", "--no-warnings"]]) {
      const result = h.run(argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`symnav: error: cannot write ${h.state}`);
    }
  });
});
