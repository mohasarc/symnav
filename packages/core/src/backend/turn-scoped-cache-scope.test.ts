import { describe, expect, it, vi } from "vitest";

import { TurnScopedCacheScope } from "./turn-scoped-cache-scope.js";

describe("TurnScopedCacheScope", () => {
  it("returns each exact factory value once per key and handle", () => {
    const scope = new TurnScopedCacheScope();
    const first = scope.createCache<string, readonly string[] | undefined>();
    const second = scope.createCache<string, readonly string[] | undefined>();
    const firstValue: readonly string[] = [];
    const secondValue: readonly string[] = [];
    const firstFactory = vi.fn(() => firstValue);
    const undefinedFactory = vi.fn(() => undefined);
    const secondFactory = vi.fn(() => secondValue);

    expect(first.getOrCreate("value", firstFactory)).toBe(firstValue);
    expect(first.getOrCreate("value", firstFactory)).toBe(firstValue);
    expect(first.getOrCreate("undefined", undefinedFactory)).toBeUndefined();
    expect(first.getOrCreate("undefined", undefinedFactory)).toBeUndefined();
    expect(second.getOrCreate("value", secondFactory)).toBe(secondValue);

    expect(firstFactory).toHaveBeenCalledOnce();
    expect(undefinedFactory).toHaveBeenCalledOnce();
    expect(secondFactory).toHaveBeenCalledOnce();
  });

  it("clears every handle at turn and release boundaries", () => {
    const scope = new TurnScopedCacheScope();
    const first = scope.createCache<string, object>();
    const second = scope.createCache<string, object>();
    const firstFactory = vi.fn(() => ({}));
    const secondFactory = vi.fn(() => ({}));
    const initialFirst = first.getOrCreate("shared", firstFactory);
    const initialSecond = second.getOrCreate("shared", secondFactory);

    scope.beginTurn();

    expect(first.getOrCreate("shared", firstFactory)).not.toBe(initialFirst);
    expect(second.getOrCreate("shared", secondFactory)).not.toBe(initialSecond);

    const nextFirst = first.getOrCreate("shared", firstFactory);
    const nextSecond = second.getOrCreate("shared", secondFactory);
    scope.releaseTransientResources();
    scope.releaseTransientResources();

    expect(first.getOrCreate("shared", firstFactory)).not.toBe(nextFirst);
    expect(second.getOrCreate("shared", secondFactory)).not.toBe(nextSecond);
    expect(firstFactory).toHaveBeenCalledTimes(3);
    expect(secondFactory).toHaveBeenCalledTimes(3);
  });

  it("retains promise settlement and retries synchronous factory failures", async () => {
    const scope = new TurnScopedCacheScope();
    const promises = scope.createCache<string, Promise<string>>();
    const values = scope.createCache<string, string>();
    const rejection = new Error("rejected");
    const rejected = Promise.reject(rejection);
    const rejectedFactory = vi.fn(() => rejected);
    const throwingFactory = vi.fn(() => {
      throw new Error("synchronous failure");
    });

    const first = promises.getOrCreate("key", rejectedFactory);
    const second = promises.getOrCreate("key", rejectedFactory);

    expect(second).toBe(first);
    await expect(first).rejects.toBe(rejection);
    expect(promises.getOrCreate("key", rejectedFactory)).toBe(first);
    expect(rejectedFactory).toHaveBeenCalledOnce();
    expect(() => values.getOrCreate("key", throwingFactory)).toThrow("synchronous failure");
    expect(() => values.getOrCreate("key", throwingFactory)).toThrow("synchronous failure");
    expect(throwingFactory).toHaveBeenCalledTimes(2);
  });

  it("does not let an old promise settlement replace a new turn entry", async () => {
    const scope = new TurnScopedCacheScope();
    const cache = scope.createCache<string, Promise<string>>();
    let settleOld: ((value: string) => void) | undefined;
    const oldPromise = new Promise<string>((resolve) => {
      settleOld = resolve;
    });
    const newPromise = Promise.resolve("new");
    expect(cache.getOrCreate("key", () => oldPromise)).toBe(oldPromise);

    scope.beginTurn();
    expect(cache.getOrCreate("key", () => newPromise)).toBe(newPromise);
    settleOld?.("old");

    await expect(oldPromise).resolves.toBe("old");
    await expect(cache.getOrCreate("key", () => Promise.resolve("other"))).resolves.toBe("new");
  });
});
