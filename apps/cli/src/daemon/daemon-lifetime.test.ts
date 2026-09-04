import type { Clock } from "@symnav/telemetry";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "@symnav/daemon/policy-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonLifetime } from "./daemon-lifetime.js";

const IDLE_TIMEOUT_MS = DaemonPolicy.currentSystem().values.shutdown.idleTimeoutMs;

describe("DaemonLifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resets its idle deadline only for navigation", async () => {
    let now = 0;
    const clock: Clock = { now: () => now };
    const onIdle = vi.fn(async () => undefined);
    const lifetime = new DaemonLifetime(clock, idlePolicy(IDLE_TIMEOUT_MS), onIdle);

    now = IDLE_TIMEOUT_MS - 1;
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    lifetime.navigationAccepted();
    lifetime.queueBecameIdle();
    now += IDLE_TIMEOUT_MS - 1;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();

    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("waits for active navigation to finish after deadline", async () => {
    let now = 0;
    const onIdle = vi.fn(async () => undefined);
    const lifetime = new DaemonLifetime({ now: () => now }, idlePolicy(10), onIdle);
    lifetime.navigationAccepted();

    now = 10;
    await vi.advanceTimersByTimeAsync(10);
    expect(onIdle).not.toHaveBeenCalled();
    lifetime.queueBecameIdle();
    await Promise.resolve();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("stops its timer permanently", async () => {
    let now = 0;
    const onIdle = vi.fn(async () => undefined);
    const lifetime = new DaemonLifetime({ now: () => now }, idlePolicy(10), onIdle);
    lifetime.stop();
    now = 20;
    await vi.advanceTimersByTimeAsync(20);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

function idlePolicy(idleTimeoutMs: number) {
  return DaemonPolicyTestFactory.withOverrides(DaemonPolicy.currentSystem(), {
    shutdown: { idleTimeoutMs },
  }).values.shutdown;
}
