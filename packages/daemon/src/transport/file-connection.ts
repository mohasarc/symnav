import { constants, existsSync, writeFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import { join } from "node:path";
import type { DaemonConnection } from "./contracts.js";

interface FileDaemonConnectionOptions {
  readonly directory: string;
  readonly side: "request" | "response";
  readonly peerPid: number;
  readonly timeoutMs?: number;
}

export class FileDaemonConnection implements DaemonConnection {
  private static readonly maximumFrameBytes = 64 * 1024;
  private static readonly pollIntervalMs = 5;
  public readonly incoming: AsyncIterable<Uint8Array>;
  private readonly outgoingDirectory: string;
  private readonly incomingDirectory: string;
  private writes = Promise.resolve();
  private destroyed = false;
  private ending = false;
  private timeoutDisabled = false;
  private readonly clock = new NodeDaemonClock();
  private lastActivityAt = this.clock.monotonicNowMs();
  private writeSequence = 0;
  private readSequence = 0;

  public constructor(private readonly options: FileDaemonConnectionOptions) {
    this.outgoingDirectory = join(options.directory, options.side);
    this.incomingDirectory = join(
      options.directory,
      options.side === "request" ? "response" : "request",
    );
    this.incoming = this.receive();
  }

  public write(frame: Uint8Array): Promise<void> {
    if (this.ending || this.destroyed)
      return Promise.reject(new Error("Daemon file connection closed"));
    const writing = this.writes.then(() => this.publish(frame));
    this.writes = writing.catch(() => {});
    return writing;
  }

  public disableTimeout(): void {
    this.timeoutDisabled = true;
  }

  public end(): void {
    if (this.ending || this.destroyed) return;
    this.ending = true;
    void this.writes
      .then(async () => {
        await this.waitUntil(() => !existsSync(join(this.outgoingDirectory, "slot.frame")));
        writeFileSync(join(this.outgoingDirectory, "end"), "", { flag: "wx", mode: 0o600 });
      })
      .catch(() => this.destroy());
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      writeFileSync(join(this.outgoingDirectory, "abort"), "", { flag: "wx", mode: 0o600 });
    } catch {}
  }

  private async publish(bytes: Uint8Array): Promise<void> {
    const framePath = join(this.outgoingDirectory, "slot.frame");
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += FileDaemonConnection.maximumFrameBytes
    ) {
      await this.waitUntil(() => !existsSync(framePath));
      const chunk = bytes.subarray(offset, offset + FileDaemonConnection.maximumFrameBytes);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(this.writeSequence, 0);
      header.writeUInt32BE(chunk.byteLength, 4);
      const temporaryPath = join(this.outgoingDirectory, `${this.writeSequence}.tmp`);
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(Buffer.concat([header, chunk]));
      } finally {
        await file.close();
      }
      this.assertOpen();
      await rename(temporaryPath, framePath);
      this.writeSequence += 1;
      this.lastActivityAt = this.clock.monotonicNowMs();
    }
  }

  private async *receive(): AsyncIterable<Uint8Array> {
    const framePath = join(this.incomingDirectory, "slot.frame");
    while (true) {
      try {
        await this.waitUntil(
          () => existsSync(framePath) || existsSync(join(this.incomingDirectory, "end")),
        );
      } catch (error) {
        if (this.ending) return;
        throw error;
      }
      if (!existsSync(framePath)) return;
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const file = await open(framePath, constants.O_RDONLY | noFollow);
      let bytes: Buffer;
      try {
        const metadata = await file.stat();
        if (
          !metadata.isFile() ||
          metadata.size < 8 ||
          metadata.size > FileDaemonConnection.maximumFrameBytes + 8
        )
          throw new Error("Corrupt daemon file frame");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      if (bytes.readUInt32BE(0) !== this.readSequence || bytes.readUInt32BE(4) !== bytes.length - 8)
        throw new Error("Corrupt daemon file frame sequence");
      this.readSequence += 1;
      this.lastActivityAt = this.clock.monotonicNowMs();
      try {
        yield bytes.subarray(8);
      } finally {
        await unlink(framePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }

  private async waitUntil(ready: () => boolean): Promise<void> {
    while (true) {
      this.assertOpen();
      if (ready()) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, FileDaemonConnection.pollIntervalMs),
      );
    }
  }

  private assertOpen(): void {
    if (
      this.destroyed ||
      existsSync(join(this.incomingDirectory, "abort")) ||
      !existsSync(this.options.directory)
    )
      throw new Error("Daemon file connection closed");
    try {
      process.kill(this.options.peerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM")
        throw new Error("Daemon file peer closed", { cause: error });
    }
    if (
      !this.timeoutDisabled &&
      this.options.timeoutMs !== undefined &&
      this.clock.monotonicNowMs() - this.lastActivityAt >= this.options.timeoutMs
    )
      throw Object.assign(new Error("Daemon file connection timed out"), { code: "ETIMEDOUT" });
  }
}
