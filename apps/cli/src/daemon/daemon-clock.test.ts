import { readFileSync, readdirSync } from "node:fs";
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
  it("keeps raw time sources and telemetry clocks outside daemon mechanisms", () => {
    const violations = readdirSync(new URL(".", import.meta.url))
      .filter(
        (file) =>
          file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "daemon-clock.ts",
      )
      .flatMap((file) => {
        const source = readFileSync(new URL(file, import.meta.url), "utf8");
        return /Date\.now|performance\.now|@symnav\/telemetry/.test(source) ? [file] : [];
      });

    expect(violations).toEqual([]);
  });
});
