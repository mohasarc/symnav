import { describe, expect, it } from "vitest";
import {
  DaemonActivityProjector,
  type DaemonActivityProjectionInput,
} from "./daemon-activity-projector.js";

describe("DaemonActivityProjector", () => {
  it.each([
    {
      name: "draining over recovering, starting, and busy",
      queueState: "draining" as const,
      resourceState: "replacing" as const,
      workerReady: false,
      active: true,
      expected: "draining",
    },
    {
      name: "stopped over recovering, starting, and busy",
      queueState: "accepting" as const,
      resourceState: "stopped" as const,
      workerReady: false,
      active: true,
      expected: "draining",
    },
    {
      name: "recovering over starting and busy",
      queueState: "accepting" as const,
      resourceState: "replacing" as const,
      workerReady: false,
      active: true,
      expected: "recovering",
    },
    {
      name: "starting over busy",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: false,
      active: true,
      expected: "starting",
    },
    {
      name: "busy over ready",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: true,
      active: true,
      expected: "busy",
    },
    {
      name: "ready without active work",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: true,
      active: false,
      expected: "ready",
    },
  ])("projects $name", ({ queueState, resourceState, workerReady, active, expected }) => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ queueState, resourceState, workerReady, active }),
    );

    expect(projection.activity.lifecycle).toBe(expected);
  });
});

interface ActivityProjectionOverrides {
  readonly queueState?: DaemonActivityProjectionInput["queue"]["state"];
  readonly resourceState?: DaemonActivityProjectionInput["resources"]["state"];
  readonly workerReady?: boolean;
  readonly active?: boolean;
}

class ActivityProjectionFixture {
  static input(overrides: ActivityProjectionOverrides = {}): DaemonActivityProjectionInput {
    const active = overrides.active ?? false;
    return {
      nowMonotonicMs: 130,
      pid: 41,
      processRssBytes: 500,
      startedAt: 1_000,
      startedMonotonicAt: 100,
      productVersion: "1.2.3",
      instanceId: "instance",
      hardProcessRssBytes: 1_000,
      queue: {
        state: overrides.queueState ?? "accepting",
        ...(active
          ? {
              active: {
                requestId: "request",
                command: "overview",
                acceptedAt: 105,
                startedAt: 110,
              },
            }
          : {}),
        queued: 2,
      },
      resources: {
        state: overrides.resourceState ?? "ready",
        generation: 3,
        processRssBytes: 400,
        peakProcessRssBytes: 600,
        spoolBytes: 70,
        admissionPaused: false,
        replacementCount: 0,
      },
      worker: {
        generation: 3,
        ready: overrides.workerReady ?? true,
        fileCount: 12,
      },
    };
  }
}
