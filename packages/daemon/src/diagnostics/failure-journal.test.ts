import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import type { DaemonFailureEvent } from "../daemon-failure.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { DaemonFailureJournal } from "./failure-journal.js";

class FailureJournalFixture {
  public static readonly policy = DaemonPolicy.currentSystem().values.diagnostics;

  public static event(
    eventId: string,
    timestamp = 10,
    kind: DaemonFailureEvent["kind"] = "fallback",
  ): DaemonFailureEvent {
    return {
      schemaVersion: 1,
      eventId,
      workspaceRoot: "/workspace",
      instanceId: "instance",
      ...(kind === "fallback" ? { requestId: eventId } : {}),
      kind,
      failure: {
        phase: "endpoint connect",
        reason: "daemon-connection-reset",
        timestamp,
        osCode: "ECONNRESET",
      },
    };
  }
}

describe("DaemonFailureJournal", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes immutable evidence independently of registry records and state locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const journal = new DaemonFailureJournal(
      root,
      FailureJournalFixture.policy,
      new NodeDaemonClock(),
    );
    const event = FailureJournalFixture.event("one");
    await journal.record(event);
    await journal.record({ ...event, failure: { ...event.failure, osCode: "EPERM" } });
    await journal.record({
      ...event,
      requestId: "changed-request",
      failure: { ...event.failure, timestamp: 1, osCode: "EACCES" },
    });
    await journal.record({
      ...event,
      eventId: "other-observer",
      failure: { ...event.failure, timestamp: 12 },
    });
    expect(await journal.recent(20)).toEqual([event]);
    expect(
      await new DaemonFailureJournal(
        join(root, "other"),
        FailureJournalFixture.policy,
        new NodeDaemonClock(),
      ).recent(20),
    ).toEqual([]);
    const identity = DaemonWorkspaceIdentity.from("/workspace", root);
    expect(await readdir(identity.identityDirectory)).toEqual(["failures"]);
    expect((await stat(join(identity.identityDirectory, "failures"))).mode & 0o777).toBe(0o700);
  });

  it("ignores partial, malformed, noncanonical and open-ended evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const journal = new DaemonFailureJournal(
      root,
      FailureJournalFixture.policy,
      new NodeDaemonClock(),
    );
    await journal.record(FailureJournalFixture.event("valid"));
    const directory = join(
      DaemonWorkspaceIdentity.from("/workspace", root).identityDirectory,
      "failures",
    );
    const [name] = await readdir(directory);
    const original = await readFile(join(directory, name!), "utf8");
    await writeFile(join(directory, "partial.tmp"), "{");
    await writeFile(join(directory, "invented.json"), original);
    expect(await journal.recent(20)).toEqual([FailureJournalFixture.event("valid")]);
    await writeFile(
      join(directory, name!),
      JSON.stringify({ ...FailureJournalFixture.event("valid"), message: "secret" }),
    );
    expect(await journal.recent(20)).toEqual([]);
    await expect(
      journal.record({
        ...FailureJournalFixture.event("bad"),
        failure: { ...FailureJournalFixture.event("bad").failure, osCode: "secret path" },
      }),
    ).rejects.toThrow();
  });

  it("filters the rolling hour inclusively and orders by event time without deleting older diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const journal = new DaemonFailureJournal(
      root,
      FailureJournalFixture.policy,
      new NodeDaemonClock(),
    );
    const events = [
      FailureJournalFixture.event("latest", 3_600_010),
      FailureJournalFixture.event("old", 9),
      FailureJournalFixture.event("boundary", 10),
      FailureJournalFixture.event("future", 3_600_011),
    ];
    for (const event of events) await journal.record(event);
    expect(await journal.recent(3_600_010)).toEqual([events[2], events[0]]);
    const directory = join(
      DaemonWorkspaceIdentity.from("/workspace", root).identityDirectory,
      "failures",
    );
    expect(await readdir(directory)).toHaveLength(4);
  });

  it("counts concurrent child writers once per request and event", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const script = `import { DaemonFailureJournal } from ${JSON.stringify(new URL("./failure-journal.ts", import.meta.url).href)};
      const journal = new DaemonFailureJournal(process.argv[1], JSON.parse(process.argv[2]), {wallNowMs: () => 20, monotonicNowMs: () => 20});
      await Promise.all(JSON.parse(process.argv[3]).map(event => journal.record(event)));`;
    await Promise.all(
      Array.from({ length: 6 }, (_, writer) =>
        promisify(execFile)(process.execPath, [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          "--input-type=module",
          "-e",
          script,
          root,
          JSON.stringify(FailureJournalFixture.policy),
          JSON.stringify(
            Array.from({ length: 8 }, (_, index) =>
              FailureJournalFixture.event(`request-${index}`, 10 + writer),
            ),
          ),
        ]),
      ),
    );
    const journal = new DaemonFailureJournal(
      root,
      FailureJournalFixture.policy,
      new NodeDaemonClock(),
    );
    expect(await journal.recent(30)).toHaveLength(8);
    const directory = join(
      DaemonWorkspaceIdentity.from("/workspace", root).identityDirectory,
      "failures",
    );
    expect(await readdir(directory)).toHaveLength(8);
    for (const name of await readdir(directory))
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  });

  it("bounds retained bytes with the diagnostics rotation budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const policy: typeof FailureJournalFixture.policy = {
      ...FailureJournalFixture.policy,
      logRotateBytes: 700,
      logBackupCount: 1,
    };
    const journal = new DaemonFailureJournal(root, policy, new NodeDaemonClock());
    for (let index = 0; index < 12; index += 1)
      await journal.record(FailureJournalFixture.event(`event-${index}`, index));
    const events = await journal.recent(20);
    expect(events.at(-1)?.eventId).toBe("event-11");
    expect(events.length).toBeGreaterThan(1);
    expect(events.length).toBeLessThan(12);
    const directory = join(
      DaemonWorkspaceIdentity.from("/workspace", root).identityDirectory,
      "failures",
    );
    const sizes = await Promise.all(
      (await readdir(directory)).map(async (name) => (await stat(join(directory, name))).size),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(1_400);
  });

  it("cleans abandoned partial publication while retaining active writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "symnav-failures-"));
    roots.push(root);
    const journal = new DaemonFailureJournal(root, FailureJournalFixture.policy, {
      wallNowMs: () => 120_000,
    });
    await journal.record(FailureJournalFixture.event("initial"));
    const directory = join(
      DaemonWorkspaceIdentity.from("/workspace", root).identityDirectory,
      "failures",
    );
    await writeFile(join(directory, "1.abandoned.tmp"), "{");
    await writeFile(join(directory, "120000.active.tmp"), "{");
    await journal.record(FailureJournalFixture.event("next"));
    expect(await readdir(directory)).not.toContain("1.abandoned.tmp");
    expect(await readdir(directory)).toContain("120000.active.tmp");
  });
});
