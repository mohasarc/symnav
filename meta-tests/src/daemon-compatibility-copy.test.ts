import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("CLI daemon compatibility copies", () => {
  it("are physically absent after daemon ownership migration", () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const daemonDirectory = join(repositoryRoot, "apps/cli/src/daemon");
    expect(existsSync(daemonDirectory) ? readdirSync(daemonDirectory) : []).toEqual([]);
  });
});
