import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createConnection = vi.hoisted(() => vi.fn());

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createConnection,
}));

import { LocalDaemonSocketClient } from "./local-daemon-socket-client.js";

describe("LocalDaemonSocketClient", () => {
  let socket: FakeSocket;

  beforeEach(() => {
    socket = new FakeSocket();
    createConnection.mockReset();
    createConnection.mockReturnValue(socket);
  });

  it.each(["/tmp/symnav/daemon.sock", String.raw`\\.\pipe\symnav-daemon`])(
    "passes the endpoint through unchanged: %s",
    async (endpoint) => {
      const connecting = new LocalDaemonSocketClient().connect(endpoint);

      socket.emit("connect");
      await connecting;

      expect(createConnection).toHaveBeenCalledWith(endpoint);
    },
  );

  it("exposes incoming bytes in arrival order", async () => {
    const connecting = new LocalDaemonSocketClient().connect("endpoint");
    socket.emit("connect");
    const connection = await connecting;
    const incoming = connection.incoming[Symbol.asyncIterator]();

    const first = incoming.next();
    socket.emit("data", Buffer.from([1, 2]));
    const second = incoming.next();
    socket.emit("data", Buffer.from([3]));
    socket.emit("end");

    await expect(first).resolves.toEqual({ done: false, value: Buffer.from([1, 2]) });
    await expect(second).resolves.toEqual({ done: false, value: Buffer.from([3]) });
    await expect(incoming.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("completes incoming bytes when the peer ends before a frame", async () => {
    const connecting = new LocalDaemonSocketClient().connect("endpoint");
    socket.emit("connect");
    const connection = await connecting;
    const incoming = connection.incoming[Symbol.asyncIterator]();
    const waiting = incoming.next();

    socket.emit("end");

    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
  });

  it("advances socket reads only when the incoming consumer is ready", async () => {
    const connecting = new LocalDaemonSocketClient().connect("endpoint");
    socket.emit("connect");
    const connection = await connecting;
    const incoming = connection.incoming[Symbol.asyncIterator]();

    expect(socket.pauseCount).toBe(1);
    expect(socket.resumeCount).toBe(0);

    const first = incoming.next();
    expect(socket.resumeCount).toBe(1);
    socket.emit("data", Buffer.from([1]));
    await first;

    expect(socket.pauseCount).toBe(2);
    expect(socket.resumeCount).toBe(1);

    const second = incoming.next();
    expect(socket.resumeCount).toBe(2);
    socket.emit("data", Buffer.from([2]));
    await second;

    expect(socket.pauseCount).toBe(3);
  });

  it("writes complete frames in call order across socket backpressure", async () => {
    socket.writeResults.push(false, true, true);
    const connecting = new LocalDaemonSocketClient({ writeChunkSize: 2 }).connect("endpoint");
    socket.emit("connect");
    const connection = await connecting;

    connection.write(Uint8Array.from([1, 2, 3]));
    connection.write(Uint8Array.from([4, 5]));

    expect(socket.writes).toEqual([Uint8Array.from([1, 2])]);

    socket.emit("drain");
    await Promise.resolve();

    expect(socket.writes).toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3]),
      Uint8Array.from([4, 5]),
    ]);
  });

  it("preserves connection refusal as the original socket error", async () => {
    const refusal = new Error("connection refused");
    const connecting = new LocalDaemonSocketClient().connect("endpoint");

    expect(() => socket.emit("error", refusal)).not.toThrow();

    await expect(connecting).rejects.toBe(refusal);
    expect(socket.destroyCount).toBe(1);

    socket.emit("connect");

    expect(socket.pauseCount).toBe(0);
    expect(socket.destroyCount).toBe(1);
  });

  it("rejects a connection that times out before the socket connects", async () => {
    const connecting = new LocalDaemonSocketClient().connect("endpoint", 25);

    expect(socket.timeoutMilliseconds).toEqual([25]);
    socket.timeout();

    await expect(connecting).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "Daemon socket timed out",
    });
    expect(socket.destroyCount).toBe(1);

    socket.emit("connect");

    expect(socket.pauseCount).toBe(0);
    expect(socket.destroyCount).toBe(1);
  });

  it("reports a connected socket timeout through incoming bytes", async () => {
    const connecting = new LocalDaemonSocketClient().connect("endpoint", 25);
    socket.emit("connect");
    const connection = await connecting;
    const incoming = connection.incoming[Symbol.asyncIterator]();
    const waiting = incoming.next();

    socket.timeout();

    await expect(waiting).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "Daemon socket timed out",
    });
    expect(socket.timeoutMilliseconds).toEqual([25]);
    expect(socket.destroyCount).toBe(1);
  });

  it("preserves a socket reset through incoming bytes", async () => {
    const reset = new Error("connection reset");
    const connecting = new LocalDaemonSocketClient().connect("endpoint");
    socket.emit("connect");
    const connection = await connecting;
    const incoming = connection.incoming[Symbol.asyncIterator]();
    const waiting = incoming.next();

    expect(() => socket.emit("error", reset)).not.toThrow();

    await expect(waiting).rejects.toBe(reset);
  });
});

class FakeSocket extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  readonly writeResults: boolean[] = [];
  destroyed = false;
  pauseCount = 0;
  resumeCount = 0;
  destroyCount = 0;
  readonly timeoutMilliseconds: number[] = [];
  private timeoutListener: (() => void) | undefined;

  setTimeout(milliseconds: number, listener?: () => void): this {
    this.timeoutMilliseconds.push(milliseconds);
    this.timeoutListener = listener;
    return this;
  }

  timeout(): void {
    this.timeoutListener?.();
  }

  pause(): this {
    this.pauseCount += 1;
    return this;
  }

  resume(): this {
    this.resumeCount += 1;
    return this;
  }

  write(frame: Uint8Array): boolean {
    this.writes.push(Uint8Array.from(frame));
    return this.writeResults.shift() ?? true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.destroyCount += 1;
    return this;
  }
}
