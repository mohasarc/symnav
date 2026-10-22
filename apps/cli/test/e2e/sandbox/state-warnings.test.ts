import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath, runSymnavBinary } from "@symnav/testing";
import { afterEach, describe, expect, it } from "vitest";

class StateWarningHarness {
  private static readonly roots: string[] = [];
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
    return { options: `--import=${new URL(`file://${guard}`).href}`, marker };
  }

  public static cleanup(): void {
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
    this.roots.length = 0;
  }
}

afterEach(() => StateWarningHarness.cleanup());

describe("symnav required state writes", () => {
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
