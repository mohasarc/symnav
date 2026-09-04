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
});

class FakeSocket extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  destroyed = false;

  setTimeout(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  resume(): this {
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
