import { expect, it, vi } from "vitest";
import type { ProgramDependencies } from "../program-dependencies.js";
import { SandboxProbeActor } from "./sandbox-probe-actor.js";

it.each([false, true])(
  "cleans only its workspace and waits for owned children even when stop fails: %s",
  async (fail) => {
    const order: string[] = [];
    const control = vi.fn(async () => {
      order.push("stop");
      if (fail) throw new Error("unresponsive");
      return { status: "stopped" };
    });
    const closeOwnedProcesses = vi.fn(async () => {
      order.push("children exited");
    });
    const dependencies = {
      daemonClient: { control, closeOwnedProcesses },
    } as unknown as ProgramDependencies;
    const actor = new SandboxProbeActor(dependencies, { run: vi.fn() }, "/scratch/workspace");
    expect(await actor.cleanup()).toEqual({
      kind: "cleaned",
      ...(fail ? { failure: "scratch daemon stop failed: unresponsive" } : {}),
    });
    await actor.cleanup();
    expect(control).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledWith({
      action: "stop",
      workspaceRoot: "/scratch/workspace",
    });
    expect(order).toEqual(["stop", "children exited"]);
  },
);
it("reports actual command stdout and status through the normal runner", async () => {
  const run = vi.fn(async (_request, context) => {
    context.stdout.write("proof\n");
    return 1;
  });
  const actor = new SandboxProbeActor({} as ProgramDependencies, { run }, "/scratch/workspace");
  expect(await actor.handle({ action: "run" })).toEqual({
    kind: "command",
    exitCode: 1,
    stdout: "proof\n",
    stderr: "",
  });
  expect(run.mock.calls[0]![0]).toMatchObject({
    argv: ["overview", "index.ts"],
    telemetryEnabled: true,
  });
});
