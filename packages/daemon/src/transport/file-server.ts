import type { DaemonProcessLifetimeIdentity } from "../process/process-lifetime-identity.js";
import { randomUUID } from "node:crypto";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import type { FileDaemonOwner } from "./file-owner.js";
import { mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    private readonly directory: string,
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
    await rm(this.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
    await rmdir(this.endpoint).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
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
    const entries = await readdir(this.directory, { withFileTypes: true });
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
    const publisher = /^[0-9]{16}-[0-9]{10}-[0-9]{10}-([a-f0-9-]{36})\.tmp$/.exec(name);
    if (publisher === null) return;
    const token = publisher[1]!;
    const lifetime: DaemonProcessLifetimeIdentity = {
      token,
      path: join(dirname(this.endpoint), "process-lifetimes", `${token}.fifo`),
    };
    if (PosixDaemonProcessLifetime.observe(lifetime) !== "exited") return;
    await rm(join(this.directory, name), {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 5,
    });
  }

  private async accept(name: string): Promise<void> {
    this.acceptedChannels.add(name);
    const directory = join(this.directory, name);
    let peer: FileDaemonOwner;
    try {
      peer = await FileDaemonEndpoint.readOwner(directory);
    } catch {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
      this.acceptedChannels.delete(name);
      return;
    }
    if (PosixDaemonProcessLifetime.observe(peer.processLifetime) === "exited") {
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 });
      this.acceptedChannels.delete(name);
      return;
    }
    const connection = new FileDaemonConnection({
      directory,
      side: "response",
      peerLifetime: peer.processLifetime,
    });
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
    const stateDirectory = dirname(endpoint);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const processLifetime = PosixDaemonProcessLifetime.current(stateDirectory);
    const token = randomUUID();
    const prepared = `${endpoint}.${token}.claim`;
    const preparedDirectory = join(prepared, token);
    await mkdir(preparedDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(preparedDirectory, "owner.json"),
        JSON.stringify({ token, pid: process.pid, processLifetime }),
        { flag: "wx", mode: 0o600 },
      );
      try {
        await rename(prepared, endpoint);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        if (!(await this.removeUnavailableEndpoint(endpoint)))
          throw new Error(`Daemon endpoint is already in use: ${endpoint}`);
        await rename(prepared, endpoint);
      }
    } catch (error) {
      await rm(prepared, { recursive: true, force: true });
      throw error;
    }
    return new ListeningFileDaemonServer(endpoint, join(endpoint, token), handler, this.options);
  }

  public async removeUnavailableEndpoint(endpoint: string): Promise<boolean> {
    let owner;
    try {
      owner = await FileDaemonEndpoint.owner(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (PosixDaemonProcessLifetime.observe(owner.processLifetime) !== "exited") return false;
    await rm(owner.directory, { recursive: true, force: true });
    try {
      await rmdir(endpoint);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw error;
    }
  }
}
