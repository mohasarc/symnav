import { afterEach, describe, expect, it } from "vitest";
import { AdversarialDaemonPeerHarness } from "../helpers/adversarial-daemon-peer-harness.js";

describe("adversarial daemon peers", () => {
  const harnesses: AdversarialDaemonPeerHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("reports startup publication only while its cross-process owner is live", async () => {
    const harness = AdversarialDaemonPeerHarness.create();
    harnesses.push(harness);
    const publisher = await harness.startStartupPublisher();

    await expect(harness.status()).resolves.toEqual([
      expect.objectContaining({
        workspaceRoot: harness.workspaceRoot,
        state: "starting",
        pid: 0,
      }),
    ]);
    await expect(publisher.publishAndExit()).resolves.toEqual({
      startingPublished: true,
      readyPublished: true,
    });
    await expect(harness.status()).resolves.toEqual([]);
  });

  it("retains authenticated ownership when a live peer stops answering ping", async () => {
    const harness = AdversarialDaemonPeerHarness.create();
    harnesses.push(harness);
    const peer = await harness.startLiveSilentPeer();
    const statusStartedAt = Date.now();

    await expect(harness.status()).resolves.toEqual([
      expect.objectContaining({
        workspaceRoot: harness.workspaceRoot,
        state: "unresponsive",
        pid: peer.pid,
      }),
    ]);

    expect(Date.now() - statusStartedAt).toBeLessThan(5_000);
    expect(harness.record()).toMatchObject({
      instanceId: peer.instanceId,
      processToken: peer.processToken,
      pid: peer.pid,
    });
  });

  it("redacts malformed authenticated activity without replacing ownership", async () => {
    const harness = AdversarialDaemonPeerHarness.create();
    harnesses.push(harness);
    const secret = "/private/source/PaymentProcessor::charge?token=secret";
    const peer = await harness.startMalformedActivityPeer(secret);
    const statusStartedAt = Date.now();
    const status = await harness.status();

    expect(Date.now() - statusStartedAt).toBeLessThan(5_000);
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status).toEqual([
      expect.objectContaining({
        workspaceRoot: harness.workspaceRoot,
        state: "unresponsive",
        pid: peer.pid,
      }),
    ]);
    expect(harness.record()).toMatchObject({
      instanceId: peer.instanceId,
      processToken: peer.processToken,
      pid: peer.pid,
    });
  });
});
