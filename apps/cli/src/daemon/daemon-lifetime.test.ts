import type { Clock } from "@symnav/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_IDLE_TIMEOUT_MS, DaemonLifetime } from "./daemon-lifetime.js";

describe("DaemonLifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resets its idle deadline only for navigation", async () => {
    let now = 0;
    const clock: Clock = { now: () => now };
    const onIdle = vi.fn(async () => undefined);
    const lifetime = new DaemonLifetime(clock, DAEMON_IDLE_TIMEOUT_MS, onIdle);

    now = DAEMON_IDLE_TIMEOUT_MS - 1;
    vi.advanceTimersByTime(DAEMON_IDLE_TIMEOUT_MS - 1);
    lifetime.navigationAccepted();
    lifetime.queueBecameIdle();
    now += DAEMON_IDLE_TIMEOUT_MS - 1;
    await vi.advanceTimersByTimeAsync(DAEMON_IDLE_TIMEOUT_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();

    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });
});
