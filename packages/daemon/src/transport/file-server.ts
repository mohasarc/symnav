import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonPolicyValues } from "../daemon-policy.js";
import type { DaemonRequestHandler, DaemonRequestServer } from "./contracts.js";
import type { DaemonServer } from "./protocol.js";
import type { DaemonWireCodec } from "./wire-codec.js";
import type { DaemonProtocolValidator } from "./protocol-validator.js";
import { FileDaemonConnection } from "./file-connection.js";
import { FileDaemonEndpoint } from "./file-endpoint.js";
import { DaemonRequestDispatcher } from "./request-dispatcher.js";

interface FileDaemonServerOptions {
  readonly codec: DaemonWireCodec;
  readonly validator: DaemonProtocolValidator;
  readonly policy: DaemonPolicyValues["transport"];
}

class ListeningFileDaemonServer implements DaemonServer {
  private readonly channels = new Map<
    string,
    { readonly connection: FileDaemonConnection; readonly finished: Promise<void> }
  >();
  private readonly acceptedChannels = new Set<string>();
  private closing: Promise<void> | undefined;
  private forceRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> = Promise.resolve();

  public constructor(
    private readonly endpoint: string,
    private readonly handler: DaemonRequestHandler,
    private readonly options: FileDaemonServerOptions,
  ) {
    this.schedule();
  }

  public close(force = false): Promise<void> {
    if (force) {
      this.forceRequested = true;
      for (const channel of this.channels.values()) channel.connection.destroy();
    }
    if (this.closing !== undefined) return this.closing;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.closing = this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    await this.scanning;
    if (this.forceRequested)
      for (const channel of this.channels.values()) channel.connection.destroy();
    await Promise.all([...this.channels.values()].map((channel) => channel.finished));
    await rm(this.endpoint, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.scanning = this.scan().catch(() => {
        void this.close(true);
      });
      void this.scanning.then(() => {
        if (this.closing === undefined) this.schedule();
      });
    }, 5);
  }

  private async scan(): Promise<void> {
    const entries = await readdir(this.endpoint, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".tmp")) {
        await this.reapUnpublishedChannel(entry.name);
        continue;
      }
      if (!/^[a-f0-9-]+\.channel$/.test(entry.name) || this.acceptedChannels.has(entry.name))
        continue;
      await this.accept(entry.name);
    }
  }

  private async reapUnpublishedChannel(name: string): Promise<void> {
    const publisher = /^[0-9]{16}-([0-9]{10})-[0-9]{10}-[a-f0-9-]{36}\.tmp$/.exec(name);
    if (publisher === null) return;
    const publisherPid = Number(publisher[1]);
    if (!Number.isSafeInteger(publisherPid) || publisherPid <= 0) return;
    if (FileDaemonEndpoint.isAlive(publisherPid)) return;
    await rm(join(this.endpoint, name), {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 5,
    });
  }

  private async accept(name: string): Promise<void> {
    this.acceptedChannels.add(name);
    const directory = join(this.endpoint, name);
    let peerPid: number;
    try {
      peerPid = await FileDaemonEndpoint.ownerPid(directory);
    } catch {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
      this.acceptedChannels.delete(name);
      return;
    }
    if (!FileDaemonEndpoint.isAlive(peerPid)) {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
      this.acceptedChannels.delete(name);
      return;
    }
    const connection = new FileDaemonConnection({ directory, side: "response", peerPid });
    const finished = this.serve(connection).finally(async () => {
      connection.destroy();
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
      this.channels.delete(name);
      this.acceptedChannels.delete(name);
    });
    void finished.catch(() => {});
    this.channels.set(name, { connection, finished });
  }

  private async serve(connection: FileDaemonConnection): Promise<void> {
    const dispatcher = new DaemonRequestDispatcher({
      codec: this.options.codec,
      validator: this.options.validator,
      handler: this.handler,
      write: (bytes) => connection.write(bytes),
      destroy: () => connection.destroy(),
    });
    try {
      for await (const bytes of connection.incoming) dispatcher.receive(bytes);
      dispatcher.end();
    } catch {
    } finally {
      dispatcher.close();
    }
  }
}

export class FileDaemonRequestServer implements DaemonRequestServer {
  public constructor(private readonly options: FileDaemonServerOptions) {}

  public async listen(endpoint: string, handler: DaemonRequestHandler): Promise<DaemonServer> {
    await mkdir(join(endpoint, ".."), { recursive: true, mode: 0o700 });
    try {
      await mkdir(endpoint, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await this.removeUnavailableEndpoint(endpoint)))
        throw new Error(`Daemon endpoint is already in use: ${endpoint}`);
      await mkdir(endpoint, { mode: 0o700 });
    }
    try {
      await writeFile(join(endpoint, "owner.json"), JSON.stringify({ pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await rm(endpoint, { recursive: true, force: true });
      throw error;
    }
    return new ListeningFileDaemonServer(endpoint, handler, this.options);
  }

  public async removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    try {
      if (FileDaemonEndpoint.isAlive(await FileDaemonEndpoint.ownerPid(endpoint))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    await rm(endpoint, { recursive: true, force: true });
    return true;
  }
}
