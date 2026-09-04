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
});

class FakeSocket extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  destroyed = false;
  pauseCount = 0;
  resumeCount = 0;

  setTimeout(): this {
    return this;
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
    this.writes.push(frame);
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}
