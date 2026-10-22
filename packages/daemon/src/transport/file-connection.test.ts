import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileDaemonConnection } from "./file-connection.js";

class FileConnectionHarness {
  public readonly roots: string[] = [];
  public async pair() {
    const root = await mkdtemp(join(tmpdir(), "symnav-file-connection-"));
    this.roots.push(root);
    await mkdir(join(root, "request"));
    await mkdir(join(root, "response"));
    return {
      root,
      client: new FileDaemonConnection({ directory: root, side: "request", peerPid: process.pid }),
      server: new FileDaemonConnection({ directory: root, side: "response", peerPid: process.pid }),
    };
  }
  public async cleanUp(): Promise<void> {
    for (const root of this.roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
}

describe("FileDaemonConnection publication", () => {
  const harness = new FileConnectionHarness();
  afterEach(() => harness.cleanUp());

  it("ignores temporary frames and delivers published bytes exactly once in order", async () => {
    const { root, client, server } = await harness.pair();
    await writeFile(join(root, "request", "unfinished.tmp"), "incomplete");
    const received: string[] = [];
    const reading = (async () => { for await (const bytes of server.incoming) received.push(Buffer.from(bytes).toString()); })();
    await client.write(Buffer.from("first"));
    await client.write(Buffer.from("second"));
    client.end();
    await reading;
    expect(received).toEqual(["first", "second"]);
    server.end();
    client.destroy();
    server.destroy();
  });

  it("bounds outstanding frames while a consumer is paused", async () => {
    const { root, client, server } = await harness.pair();
    const iterator = server.incoming[Symbol.asyncIterator]();
    const bytes = Buffer.alloc(3 * 64 * 1024, 93);
    let finished = false;
    const writing = client.write(bytes).then(() => { finished = true; });
    const first = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(false);
    expect((await readdir(join(root, "request"))).filter((name) => name.endsWith(".frame"))).toHaveLength(1);
    const second = await iterator.next();
    const third = await iterator.next();
    await writing;
    expect(Buffer.concat([Buffer.from(first.value!), Buffer.from(second.value!), Buffer.from(third.value!)])).toEqual(bytes);
    client.destroy();
    server.destroy();
    await iterator.return?.();
  });

  it("interrupts blocked readers and writers on forced close", async () => {
    const { client, server } = await harness.pair();
    await client.write(Buffer.from("published"));
    const blocked = client.write(Buffer.from("blocked"));
    server.destroy();
    await expect(blocked).rejects.toThrow(/closed/);
    client.destroy();
  });
});
