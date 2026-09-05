import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("daemon executable entry boundary", () => {
  it.each(["process-entry", "worker-entry"])("keeps %s free of named exports", (entry) => {
    const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
    const declaration = readFileSync(join(packageDirectory, "dist", `${entry}.d.ts`), "utf8");

    expect(declaration).not.toMatch(/export (?:declare|class|function|interface|type|const|let|var)/);
  });
});
