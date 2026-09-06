import { beforeEach, expect, it, vi } from "vitest";
import type { DaemonClientOptions } from "@symnav/daemon";

const captured = vi.hoisted(() => ({ options: [] as DaemonClientOptions[] }));

vi.mock("@symnav/daemon", async (importOriginal) => {
  const daemon = await importOriginal<typeof import("@symnav/daemon")>();
  return {
    ...daemon,
    DaemonClient: class {
      constructor(options: DaemonClientOptions) {
        captured.options.push(options);
      }
    },
  };
});

import { DaemonPolicy } from "@symnav/daemon";
import { createDefaultDependencies } from "./program.js";

beforeEach(() => {
  captured.options.length = 0;
});

it.each([true, false])("passes daemonEnabled=%s to dependencies and DaemonClient", (daemonEnabled) => {
  const policy = DaemonPolicy.fromSystemMemory({ totalBytes: 8 * 1024 ** 3 });

  const dependencies = createDefaultDependencies("/canonical/state", policy, daemonEnabled);

  expect(dependencies.daemonEnabled).toBe(daemonEnabled);
  expect(captured.options).toHaveLength(1);
  expect(captured.options[0]).toMatchObject({
    stateDirectory: "/canonical/state",
    productVersion: "0.1.0",
    daemonEnabled,
    policy,
    readinessProbe: { commandName: "version", argv: ["--version"] },
  });
  expect(new URL(captured.options[0]!.executorModuleUrl).protocol).toBe("file:");
  expect(dependencies.daemonClient).toBeDefined();
});
