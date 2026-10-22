import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DaemonPolicyValues } from "../daemon-policy.js";
import type { DaemonConnection, DaemonConnectionClient } from "./contracts.js";
import { FileDaemonConnection } from "./file-connection.js";
import { LocalDaemonSocketClient } from "./socket-client.js";
import { FileDaemonEndpoint } from "./file-endpoint.js";

interface FileDaemonConnectionClientOptions {
  readonly policy: DaemonPolicyValues["transport"];
}

export class FileDaemonConnectionClient implements DaemonConnectionClient {
  private static readonly clock = new NodeDaemonClock();
  private static connectionSequence = 0;

  public constructor(private readonly options: FileDaemonConnectionClientOptions) {}

  public async connect(endpoint: string, timeoutMs?: number): Promise<DaemonConnection> {
    if (endpoint.endsWith(".sock"))
      return new LocalDaemonSocketClient().connect(endpoint, timeoutMs);
    const lifetime = PosixDaemonProcessLifetime.current(dirname(endpoint));
    const identifier = `${String(FileDaemonConnectionClient.clock.wallNowMs()).padStart(16, "0")}-${String(process.pid).padStart(10, "0")}-${String(FileDaemonConnectionClient.connectionSequence++).padStart(10, "0")}-${lifetime.token}`;
    const peer = await FileDaemonEndpoint.owner(endpoint);
    if (PosixDaemonProcessLifetime.observe(peer.processLifetime) === "exited")
      throw Object.assign(new Error("Daemon file endpoint unavailable"), { code: "ECONNREFUSED" });
    const temporaryDirectory = join(peer.directory, `${identifier}.tmp`);
    const directory = join(peer.directory, `${identifier}.channel`);
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      await mkdir(join(temporaryDirectory, "request"), { mode: 0o700 });
      await mkdir(join(temporaryDirectory, "response"), { mode: 0o700 });
      await writeFile(
        join(temporaryDirectory, "owner.json"),
        JSON.stringify({ pid: process.pid, token: randomUUID(), processLifetime: lifetime }),
        { flag: "wx", mode: 0o600 },
      );
      if (!FileDaemonEndpoint.sameOwner(await FileDaemonEndpoint.owner(endpoint), peer))
        throw new Error("Daemon file endpoint owner changed");
      await rename(temporaryDirectory, directory);
      return new FileDaemonConnection({
        directory,
        side: "request",
        peerLifetime: peer.processLifetime,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error)
        throw DaemonStateWriteErrors.failedWrite(directory, error);
      throw error;
    }
  }
}
