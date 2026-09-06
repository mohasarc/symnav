import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeDaemonClock } from "./daemon-clock.js";

describe("NodeDaemonClock", () => {
  it("keeps elapsed time monotonic when wall time moves backwards", () => {
    let wallNowMs = 1_000;
    let monotonicNowMs = 20;
    const clock = new NodeDaemonClock({
      wallNowMs: () => wallNowMs,
      monotonicNowMs: () => monotonicNowMs,
    });
    const startedAt = clock.monotonicNowMs();

    wallNowMs = -50_000;
    monotonicNowMs = 37;

    expect(clock.wallNowMs()).toBe(-50_000);
    expect(Math.max(0, clock.monotonicNowMs() - startedAt)).toBe(17);
  });

  it("clamps a skewed monotonic source without mixing absolute clocks", () => {
    let monotonicNowMs = 10;
    const clock = new NodeDaemonClock({
      wallNowMs: () => 9_000_000,
      monotonicNowMs: () => monotonicNowMs,
    });
    const startedAt = clock.monotonicNowMs();

    monotonicNowMs = 4;

    expect(Math.max(0, clock.monotonicNowMs() - startedAt)).toBe(0);
  });
});

describe("daemon production clock ownership", () => {
  it.each([
    ["constructed wall clock", "const now = new Date().getTime();"],
    [
      "aliased monotonic import",
      'import { performance as timer } from "node:perf_hooks"; timer.now();',
    ],
  ])("recognizes %s as a raw clock source", (_name, source) => {
    expect(/Date\.now|performance\.now|process\.hrtime|@symnav\/telemetry/.test(source)).toBe(true);
  });

  it("keeps raw time sources and telemetry clocks outside daemon mechanisms", () => {
    const sourceRoot = new URL("../", import.meta.url);
    const violations = productionSources(sourceRoot).flatMap((file) => {
      if (file.endsWith("/lifecycle/daemon-clock.ts")) return [];
      const source = readFileSync(file, "utf8");
      return /Date\.now|performance\.now|process\.hrtime|@symnav\/telemetry/.test(source)
        ? [file]
        : [];
    });

    expect(violations).toEqual([]);
  });
});

function productionSources(directory: URL): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const entry = new URL(name, directory);
    if (statSync(entry).isDirectory()) return productionSources(new URL(`${name}/`, directory));
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [entry.pathname] : [];
  });
}
